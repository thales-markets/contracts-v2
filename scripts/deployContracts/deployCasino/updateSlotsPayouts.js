const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

// Target ~90% RTP with equal symbol weights [20,20,20,20,20]
// RTP = (1/125) × Σ (1 + 0.98 × raw_mult)
// Clean doubling ladder, sum = 110 → RTP ≈ 90.24%
// Stays within maxPayoutMultiplier = 50 (no bankroll lockup change)
const NEW_TRIPLE_PAYOUTS = [
	ethers.parseEther('4'), // symbol 0: 4x  (was 2x)
	ethers.parseEther('8'), // symbol 1: 8x  (was 5x)
	ethers.parseEther('16'), // symbol 2: 16x (was 10x)
	ethers.parseEther('32'), // symbol 3: 32x (was 20x)
	ethers.parseEther('50'), // symbol 4: 50x (jackpot, unchanged)
];

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	console.log('Owner:', owner.address);
	console.log('Network:', network);
	console.log('Slots:', slotsAddress);
	console.log('houseEdge:', ethers.formatEther(await slots.houseEdge()));
	console.log('symbolCount:', (await slots.symbolCount()).toString());

	console.log('\nCurrent triple payouts:');
	for (let i = 0; i < 5; i++) {
		const current = await slots.triplePayout(i);
		console.log(`  symbol ${i}: ${ethers.formatEther(current)}x`);
	}

	console.log('\nUpdating triple payouts...');
	for (let i = 0; i < NEW_TRIPLE_PAYOUTS.length; i++) {
		const newValue = NEW_TRIPLE_PAYOUTS[i];
		const current = await slots.triplePayout(i);
		if (current === newValue) {
			console.log(`  symbol ${i}: already ${ethers.formatEther(newValue)}x, skipping`);
			continue;
		}
		const tx = await slots.setTriplePayout(i, newValue);
		await tx.wait();
		console.log(`  symbol ${i}: ${ethers.formatEther(newValue)}x set (tx: ${tx.hash})`);
		await delay(2000);
	}

	console.log('\nVerifying new triple payouts:');
	let sumRaw = 0n;
	for (let i = 0; i < 5; i++) {
		const current = await slots.triplePayout(i);
		const currentNum = Number(ethers.formatEther(current));
		sumRaw += BigInt(currentNum * 100); // *100 for cents precision
		console.log(`  symbol ${i}: ${currentNum}x`);
	}

	// RTP = (1/125) × Σ (1 + 0.98 × raw_mult)
	const houseEdgeRaw = await slots.houseEdge();
	const houseEdgeNum = Number(ethers.formatEther(houseEdgeRaw));
	const sumRawNum = Number(sumRaw) / 100;
	const rtp = (5 + (1 - houseEdgeNum) * sumRawNum) / 125;
	console.log(`\nRaw payout sum: ${sumRawNum}`);
	console.log(`House edge: ${(houseEdgeNum * 100).toFixed(2)}%`);
	console.log(`RTP: ${(rtp * 100).toFixed(2)}%`);
	console.log(`Effective house edge: ${((1 - rtp) * 100).toFixed(2)}%`);

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
