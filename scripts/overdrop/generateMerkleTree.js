const fs = require('fs');
const path = require('path');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { ethers } = require('hardhat');

/**
 * Parse CSV file and return array of reward entries
 * @param {string} csvFilePath - Path to the CSV file
 * @returns {Array} Array of {address, amount} objects
 */
function parseCSV(csvFilePath) {
	const csvContent = fs.readFileSync(csvFilePath, 'utf8');
	const lines = csvContent.split('\n').filter((line) => line.trim() !== '');

	const rewards = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		const [address, amountStr] = line.split(',').map((item) => item.trim());

		if (!address || !amountStr) {
			console.warn(`Skipping line ${i + 1}: Invalid format - ${line}`);
			continue;
		}

		// Validate Ethereum address
		if (!ethers.isAddress(address)) {
			console.warn(`Skipping line ${i + 1}: Invalid address - ${address}`);
			continue;
		}

		// Parse amount (assuming it's in wei or base units)
		const amount = ethers.getBigInt(amountStr);

		rewards.push({
			address: ethers.getAddress(address), // Normalize address checksum
			amount: amount.toString(),
		});
	}

	return rewards;
}

/**
 * Generate merkle tree from reward entries
 * @param {Array} rewards - Array of {address, amount} objects
 * @returns {Object} Object containing tree, root, and proofs
 */
function generateMerkleTree(rewards) {
	// Create leaves using the same encoding as the smart contract
	const leaves = rewards.map(({ address, amount }) => {
		return keccak256(ethers.solidityPacked(['address', 'uint256'], [address, amount]));
	});

	// Create merkle tree
	const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
	const root = tree.getHexRoot();

	// Generate proofs for each address
	const proofs = {};
	rewards.forEach(({ address, amount }, index) => {
		const leaf = leaves[index];
		const proof = tree.getHexProof(leaf);
		proofs[address] = {
			amount: amount,
			proof: proof,
		};
	});

	return {
		tree,
		root,
		proofs,
		leaves: leaves.map((leaf) => '0x' + leaf.toString('hex')),
	};
}

/**
 * Save merkle tree data to files
 * @param {Object} treeData - Tree data from generateMerkleTree
 * @param {string} outputDir - Directory to save files
 */
function saveTreeData(treeData, outputDir) {
	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	// Save merkle root
	const rootData = {
		merkleRoot: treeData.root,
		leavesCount: Object.keys(treeData.proofs).length,
		generatedAt: new Date().toISOString(),
	};

	fs.writeFileSync(path.join(outputDir, 'merkleRoot.json'), JSON.stringify(rootData, null, 2));

	// Save proofs for all addresses
	const proofsData = {
		merkleRoot: treeData.root,
		proofs: treeData.proofs,
		generatedAt: new Date().toISOString(),
	};

	fs.writeFileSync(path.join(outputDir, 'merkleProofs.json'), JSON.stringify(proofsData, null, 2));

	// Save leaves for debugging
	const leavesData = {
		leaves: treeData.leaves,
		generatedAt: new Date().toISOString(),
	};

	fs.writeFileSync(path.join(outputDir, 'merkleLeaves.json'), JSON.stringify(leavesData, null, 2));

	console.log(`\nMerkle tree data saved to: ${outputDir}`);
	console.log(`Files generated:`);
	console.log(`   - merkleRoot.json (contains the root hash)`);
	console.log(`   - merkleProofs.json (contains proofs for all addresses)`);
	console.log(`   - merkleLeaves.json (contains all leaves for debugging)`);
}

function testRandomProof(treeData, rewards) {
	const randomIndex = Math.floor(Math.random() * rewards.length);
	const randomReward = rewards[randomIndex];
	const randomProof = treeData.proofs[randomReward.address];

	const isValid = verifyProof(
		randomReward.address,
		randomReward.amount,
		randomProof.proof,
		treeData.root
	);

	console.log(`Verification check (random entry):`);
	console.log(`   Address: ${randomReward.address}`);
	console.log(`   Amount: ${randomReward.amount}`);
	console.log(`   Proof valid: ${isValid ? 'YES' : 'NO'}`);
}
/**
 * Verify a specific proof
 * @param {string} address - The address to verify
 * @param {string} amount - The reward amount
 * @param {Array} proof - The merkle proof
 * @param {string} root - The merkle root
 * @returns {boolean} Whether the proof is valid
 */
function verifyProof(address, amount, proof, root) {
	const leaf = keccak256(ethers.solidityPacked(['address', 'uint256'], [address, amount]));

	const tree = new MerkleTree([], keccak256, { sortPairs: true });
	return tree.verify(proof, leaf, root);
}

/**
 * Main function to generate merkle tree from CSV
 */
async function main() {
	const args = process.argv.slice(2);

	if (args.length < 1) {
		console.log('Usage: node generateMerkleTree.js <csv-file-path> [output-directory]');
		console.log('');
		console.log('Example:');
		console.log('  node scripts/overdrop/generateMerkleTree.js rewards.csv');
		console.log('  node scripts/overdrop/generateMerkleTree.js data/rewards.csv custom-output/');
		process.exit(1);
	}

	const csvFilePath = args[0];
	// Default output directory is in the same folder as this script
	const defaultOutputDir = path.join(__dirname, 'merkle-output');
	const outputDir = args[1] || defaultOutputDir;

	try {
		console.log(`Reading CSV file: ${csvFilePath}`);
		const rewards = parseCSV(csvFilePath);

		if (rewards.length === 0) {
			console.error('No valid rewards found in CSV file');
			process.exit(1);
		}

		console.log(`Parsed ${rewards.length} reward entries`);

		const totalRewards = rewards.reduce((sum, { amount }) => {
			return sum + ethers.getBigInt(amount);
		}, 0n);

		console.log(
			`Total rewards: ${ethers.formatEther(totalRewards)} ETH (${totalRewards.toString()} wei)`
		);

		console.log(`Generating merkle tree...`);
		const treeData = generateMerkleTree(rewards);

		console.log(`Merkle tree generated successfully`);
		console.log(`Merkle Root: ${treeData.root}`);

		// Save data
		saveTreeData(treeData, outputDir);
		testRandomProof(treeData, rewards);
		console.log(`\nComplete! The merkle root: (${treeData.root}) is ready.`);
	} catch (error) {
		console.error('Error generating merkle tree:', error.message);
		process.exit(1);
	}
}

// Export functions for testing or other scripts
module.exports = {
	parseCSV,
	generateMerkleTree,
	verifyProof,
	saveTreeData,
};

// Run main function if this script is executed directly
if (require.main === module) {
	main().catch(console.error);
}
