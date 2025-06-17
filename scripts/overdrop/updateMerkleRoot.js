const fs = require('fs');
const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../helpers');

/**
 * Load merkle root from file
 * @param {string} rootFilePath - Path to the merkle root JSON file
 * @returns {Object} Root data
 */
function loadMerkleRoot(rootFilePath) {
	if (!fs.existsSync(rootFilePath)) {
		throw new Error(`Merkle root file not found: ${rootFilePath}`);
	}

	const rootContent = fs.readFileSync(rootFilePath, 'utf8');
	return JSON.parse(rootContent);
}

/**
 * Update the OverdropRewards contract with a new merkle root
 * @param {string} contractAddress - Address of the OverdropRewards contract
 * @param {string} merkleRoot - New merkle root
 * @param {string} totalRewards - Total rewards amount in wei
 * @param {boolean} resetClaims - Whether to reset claims
 * @param {Object} signer - Ethereum signer
 */
async function updateContractMerkleRoot(
	contractAddress,
	merkleRoot,
	newSeason,
	resetClaims,
	signer
) {
	// Get contract ABI
	const OverdropRewardsArtifact = await hre.artifacts.readArtifact('OverdropRewards');

	const contract = new ethers.Contract(contractAddress, OverdropRewardsArtifact.abi, signer);
	console.log(`Updating merkle root on contract: ${contractAddress}`);
	console.log(`New root: ${merkleRoot}`);
	console.log(`Reset claims: ${resetClaims}`);
	console.log(`Season: ${newSeason}`);

	const tx = await contract.updateMerkleRoot(merkleRoot, resetClaims, newSeason);
	console.log(`Transaction sent: ${tx.hash}`);

	const receipt = await tx.wait();
	console.log(`Transaction confirmed in block: ${receipt.blockNumber}`);

	return receipt;
}

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	try {
		// Configuration - you can modify these values as needed
		const rootFilePath = 'merkle-output/merkleRoot.json'; // Default merkle root file path
		const resetClaims = false; // Set to true if you want to reset claims
		const newSeason = 1;
		// Get contract address from deployments
		const contractAddress = getTargetAddress('OverdropRewards', networkObj.chainId);

		if (!contractAddress) {
			throw new Error(
				`OverdropRewards contract address not found for network: ${network} (chainId: ${networkObj.chainId})`
			);
		}

		console.log(`Loading merkle root from: ${rootFilePath}`);
		const rootData = loadMerkleRoot(rootFilePath);

		console.log(`Contract address: ${contractAddress}`);

		await updateContractMerkleRoot(
			contractAddress,
			rootData.merkleRoot,
			newSeason,
			resetClaims,
			owner
		);

		await delay(2000);

		console.log(`\nMerkle root updated successfully!`);
	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
