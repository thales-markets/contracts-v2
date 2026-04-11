const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const spinId = Number(process.env.SPIN_ID || 1);
	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	const base = await slots.getSpinBase(spinId);
	const details = await slots.getSpinDetails(spinId);
	console.log(`Spin ${spinId}`);
	console.log('  user:         ', base.user);
	console.log('  collateral:   ', base.collateral);
	console.log('  amount:       ', ethers.formatUnits(base.amount, 6), 'USDC');
	console.log('  payout:       ', ethers.formatUnits(base.payout, 6), 'USDC');
	const statusNames = ['NONE', 'PENDING', 'RESOLVED', 'CANCELLED'];
	console.log('  status:       ', statusNames[Number(details.status)]);
	console.log('  won:          ', details.won);
	console.log(
		'  reels:        ',
		`[${details.reels[0]}, ${details.reels[1]}, ${details.reels[2]}]`
	);
	console.log('  reservedProf: ', ethers.formatUnits(base.reservedProfit, 6), 'USDC');
	console.log('  placedAt:     ', new Date(Number(base.placedAt) * 1000).toISOString());
	console.log('  resolvedAt:   ', new Date(Number(base.resolvedAt) * 1000).toISOString());

	const houseEdge = Number(ethers.formatEther(await slots.houseEdge()));
	const triple = Number(ethers.formatEther(await slots.triplePayout(details.reels[0])));
	const pair = Number(ethers.formatEther(await slots.pairPayout(details.reels[0])));
	console.log('\n  pair raw multiplier for first symbol:   ', pair, 'x');
	console.log('  triple raw multiplier for first symbol: ', triple, 'x');
	console.log('  house edge:                             ', houseEdge);

	const r = details.reels;
	const amt = Number(ethers.formatUnits(base.amount, 6));
	if (Number(r[0]) === Number(r[1]) && Number(r[1]) === Number(r[2])) {
		const expected = amt * (1 + triple * (1 - houseEdge));
		console.log(`  expected payout (triple): ${expected} USDC`);
	} else if (Number(r[0]) === Number(r[1]) || Number(r[1]) === Number(r[2])) {
		const expected = amt * (1 + pair * (1 - houseEdge));
		console.log(`  expected payout (pair):   ${expected} USDC`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
