const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { getTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Network:', network);

	// Get the deployed contract address
	const overdropRewardsAddress = getTargetAddress('OverdropRewards', network);

	if (!overdropRewardsAddress) {
		console.error('OverdropRewards not deployed on this network');
		return;
	}

	console.log('OverdropRewards contract:', overdropRewardsAddress);

	// Load the merkle proofs
	const proofsPath = path.join(__dirname, 'merkle-output', 'merkleProofs.json');

	if (!fs.existsSync(proofsPath)) {
		console.error('Merkle proofs not found. Run generateMerkleTree.js first.');
		return;
	}

	const proofsData = JSON.parse(fs.readFileSync(proofsPath, 'utf8'));
	console.log('Loaded merkle proofs for', Object.keys(proofsData.proofs).length, 'addresses');

	// Get the contract instance
	const overdropRewards = await ethers.getContractAt('OverdropRewards', overdropRewardsAddress);

	// Check contract status
	const claimsEnabled = await overdropRewards.claimsEnabled();
	const currentSeason = await overdropRewards.currentSeason();
	const merkleRoot = await overdropRewards.merkleRoot();
	const remainingRewards = await overdropRewards.remainingRewards();

	console.log('\n=== Contract Status ===');
	console.log('Claims enabled:', claimsEnabled);
	console.log('Current season:', currentSeason.toString());
	console.log('Merkle root:', merkleRoot);
	console.log('Remaining rewards:', ethers.formatEther(remainingRewards), 'ETH');

	// Test with the first address from the proofs
	const addresses = Object.keys(proofsData.proofs);
	const testAddress = addresses[0];
	const testProof = proofsData.proofs[testAddress];

	console.log('\n=== Testing Proof Verification ===');
	console.log('Test address:', testAddress);
	console.log('Test amount:', ethers.formatEther(testProof.amount), 'ETH');

	// Verify the proof
	const isValidProof = await overdropRewards.verifyProof(
		testAddress,
		testProof.amount,
		testProof.proof
	);

	console.log('Proof valid:', isValidProof);

	// Check if already claimed
	const hasClaimed = await overdropRewards.hasClaimedRewards(testAddress);
	console.log('Already claimed:', hasClaimed);

	// If we're testing on a local network and have the private key, we can actually claim
	const isLocalNetwork = network === 'localhost' || network === 'hardhat';

	if (isLocalNetwork && !hasClaimed && claimsEnabled && isValidProof) {
		console.log('\n=== Attempting Test Claim ===');
		console.log(
			'Note: This will only work if you control the test address or are on a test network'
		);

		try {
			// For demo purposes, we'll just show what the transaction would look like
			console.log('Transaction data for claiming:');
			console.log('Contract:', overdropRewardsAddress);
			console.log('Method: claimRewards');
			console.log('Amount:', testProof.amount);
			console.log('Proof:', JSON.stringify(testProof.proof, null, 2));
		} catch (error) {
			console.log('Claim failed (expected if not controlling the address):', error.message);
		}
	}

	console.log('\n=== All Available Claims ===');
	for (const [address, proofData] of Object.entries(proofsData.proofs)) {
		const claimed = await overdropRewards.hasClaimedRewards(address);
		console.log(
			`${address}: ${ethers.formatEther(proofData.amount)} ETH - ${
				claimed ? 'CLAIMED' : 'AVAILABLE'
			}`
		);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
