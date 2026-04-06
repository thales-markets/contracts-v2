const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const STATUS_NAMES = ['NONE', 'PENDING', 'RESOLVED', 'CANCELLED'];

async function main() {
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	const spinId = 1;
	const spin = await slots.spins(spinId);

	console.log(`\n--- Spin #${spinId} ---`);
	console.log('User:', spin.user);
	console.log('Collateral:', spin.collateral);
	console.log('Amount:', ethers.formatUnits(spin.amount, 6), 'USDC');
	console.log('Status:', STATUS_NAMES[Number(spin.status)]);
	console.log('Won:', spin.won);
	console.log('Payout:', ethers.formatUnits(spin.payout, 6), 'USDC');
	// Note: reels (uint8[3]) is not included in public mapping getter
	console.log('Placed at:', new Date(Number(spin.placedAt) * 1000).toISOString());
	if (spin.resolvedAt > 0n) {
		console.log('Resolved at:', new Date(Number(spin.resolvedAt) * 1000).toISOString());
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
