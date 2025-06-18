const fs = require('fs');
const path = require('path');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { ethers } = require('hardhat');

/**
 * Fetch leaderboard data from Overdrop API
 * @returns {Promise<Array>} Array of leaderboard entries
 */
async function fetchLeaderboardData() {
	const url = 'https://overdrop.overtime.io/leaderboard';

	try {
		console.log('Fetching leaderboard data from:', url);
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json();
		console.log(`Successfully fetched ${data.length} leaderboard entries`);

		return data;
	} catch (error) {
		console.error('Error fetching leaderboard data:', error.message);
		throw error;
	}
}

/**
 * Parse leaderboard data and return separate arrays for OP and ARB rewards
 * @param {Array} leaderboardData - Array of leaderboard entries
 * @returns {Object} Object containing {opRewards, arbRewards} arrays
 */
function parseLeaderboardData(leaderboardData) {
	const opRewards = [];
	const arbRewards = [];

	for (const entry of leaderboardData) {
		const { address, rewards } = entry;

		// Validate Ethereum address
		if (!ethers.isAddress(address)) {
			console.warn(`Skipping invalid address: ${address}`);
			continue;
		}

		// Add OP rewards if amount > 0
		if (rewards.op && rewards.op > 0) {
			// Round to 18 decimal places max to avoid parseEther precision issues
			const opAmountStr = Number(rewards.op).toFixed(12);
			const opAmount = ethers.parseEther(opAmountStr);
			opRewards.push({
				address: ethers.getAddress(address),
				amount: opAmount.toString(),
			});
		}

		// Add ARB rewards if amount > 0
		if (rewards.arb && rewards.arb > 0) {
			// Round to 18 decimal places max to avoid parseEther precision issues
			const arbAmountStr = Number(rewards.arb).toFixed(12);
			const arbAmount = ethers.parseEther(arbAmountStr);
			arbRewards.push({
				address: ethers.getAddress(address),
				amount: arbAmount.toString(),
			});
		}
	}

	return { opRewards, arbRewards };
}

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
 * @param {Object} collateralInfo - Optional collateral information {collateral, collateralAddress}
 */
function saveTreeData(treeData, outputDir, collateralInfo = null) {
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

	// Save proofs for all addresses - convert to array format
	const proofsArray = Object.entries(treeData.proofs).map(([address, data]) => {
		const proofData = {
			address: address,
			amount: data.amount,
			proof: data.proof,
		};

		// // Add collateral info if provided
		// if (collateralInfo) {
		// 	proofData.collateral = collateralInfo.collateral;
		// 	proofData.collateralAddress = collateralInfo.collateralAddress;
		// }

		return proofData;
	});

	const proofsData = {
		merkleRoot: treeData.root,
		proofs: proofsArray,
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
 * Generate both OP and ARB merkle trees from leaderboard data
 */
async function generateFromLeaderboard() {
	const leaderboardData = await fetchLeaderboardData();
	const { opRewards, arbRewards } = parseLeaderboardData(leaderboardData);

	console.log(`Parsed ${opRewards.length} OP reward entries`);
	console.log(`Parsed ${arbRewards.length} ARB reward entries`);

	// Generate OP merkle tree
	if (opRewards.length > 0) {
		const opOutputDir = path.join(__dirname, 'opRewards');
		const opTreeData = generateMerkleTree(opRewards);

		const opCollateralInfo = {
			collateral: 'OP',
			collateralAddress: '0x4200000000000000000000000000000000000042',
		};

		console.log(`\nGenerating OP merkle tree...`);
		console.log(`OP Merkle Root: ${opTreeData.root}`);

		saveTreeData(opTreeData, opOutputDir, opCollateralInfo);
		testRandomProof(opTreeData, opRewards);

		const opTotalRewards = opRewards.reduce((sum, { amount }) => {
			return sum + ethers.getBigInt(amount);
		}, 0n);
		console.log(`Total OP rewards: ${ethers.formatEther(opTotalRewards)} OP`);
	}

	// Generate ARB merkle tree
	if (arbRewards.length > 0) {
		const arbOutputDir = path.join(__dirname, 'arbRewards');
		const arbTreeData = generateMerkleTree(arbRewards);

		const arbCollateralInfo = {
			collateral: 'ARB',
			collateralAddress: '0x912CE59144191C1204E64559FE8253a0e49E6548',
		};

		console.log(`\nGenerating ARB merkle tree...`);
		console.log(`ARB Merkle Root: ${arbTreeData.root}`);

		saveTreeData(arbTreeData, arbOutputDir, arbCollateralInfo);
		testRandomProof(arbTreeData, arbRewards);

		const arbTotalRewards = arbRewards.reduce((sum, { amount }) => {
			return sum + ethers.getBigInt(amount);
		}, 0n);
		console.log(`Total ARB rewards: ${ethers.formatEther(arbTotalRewards)} ARB`);
	}

	console.log(`\nComplete! Both merkle trees generated successfully.`);
}

/**
 * Main function to generate merkle tree from CSV
 */
async function main() {
	const args = process.argv.slice(2);

	// Check if user wants to generate from leaderboard data
	if (args.length === 1 && args[0] === '--leaderboard') {
		await generateFromLeaderboard();
		return;
	}

	if (args.length < 1) {
		console.log('Usage: node generateMerkleTree.js <csv-file-path> [output-directory]');
		console.log('       node generateMerkleTree.js --leaderboard');
		console.log('');
		console.log('Examples:');
		console.log('  node scripts/overdrop/generateMerkleTree.js rewards.csv');
		console.log('  node scripts/overdrop/generateMerkleTree.js data/rewards.csv custom-output/');
		console.log('  node scripts/overdrop/generateMerkleTree.js --leaderboard');
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
	parseLeaderboardData,
	fetchLeaderboardData,
	generateMerkleTree,
	verifyProof,
	saveTreeData,
	generateFromLeaderboard,
};

// Run main function if this script is executed directly
if (require.main === module) {
	main().catch(console.error);
}
