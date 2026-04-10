const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const bet = ethers.parseUnits('3', 6);

	const dice = await ethers.getContractAt('Dice', getTargetAddress('Dice', network));
	const roulette = await ethers.getContractAt('Roulette', getTargetAddress('Roulette', network));
	const baccarat = await ethers.getContractAt('Baccarat', getTargetAddress('Baccarat', network));
	const slots = await ethers.getContractAt('Slots', getTargetAddress('Slots', network));
	const blackjack = await ethers.getContractAt('Blackjack', getTargetAddress('Blackjack', network));

	console.log('=== Batch 3 ===');
	await dice.placeBet(usdcAddress, bet, 1, 15, ethers.ZeroAddress);
	console.log('Dice: ROLL_OVER target=15');
	await delay(3000);

	await slots.spin(usdcAddress, bet, ethers.ZeroAddress);
	console.log('Slots: spin');
	await delay(3000);

	await roulette.placeBet(usdcAddress, bet, 4, 0, ethers.ZeroAddress); // DOZEN, first dozen
	console.log('Roulette: DOZEN first');
	await delay(3000);

	await baccarat.placeBet(usdcAddress, bet, 2, ethers.ZeroAddress); // TIE
	console.log('Baccarat: TIE');
	await delay(3000);

	await blackjack.placeBet(usdcAddress, bet, ethers.ZeroAddress);
	console.log('Blackjack: deal');

	console.log('\nWaiting 35s for VRF...');
	await delay(35000);

	// Final count and resolution check
	const totalDice = Number(await dice.nextBetId()) - 1;
	const totalRoulette = Number(await roulette.nextBetId()) - 1;
	const totalBJ = Number(await blackjack.nextHandId()) - 1;
	const totalBac = Number(await baccarat.nextBetId()) - 1;
	const totalSlots = Number(await slots.nextSpinId()) - 1;

	console.log(`\n=== Totals ===`);
	console.log(`Dice: ${totalDice} bets`);
	console.log(`Roulette: ${totalRoulette} bets`);
	console.log(`Blackjack: ${totalBJ} hands`);
	console.log(`Baccarat: ${totalBac} bets`);
	console.log(`Slots: ${totalSlots} spins`);

	// Check resolution
	let pending = [];
	for (let i = 1; i <= totalDice; i++) {
		const d = await dice.getBetDetails(i);
		const b = await dice.getBetBase(i);
		const status = Number(d.status) === 2 ? 'RESOLVED' : `PENDING(${d.status})`;
		console.log(
			`  Dice #${i}: ${status}, won=${d.won}, result=${d.result}, payout=${ethers.formatUnits(
				b.payout,
				6
			)}`
		);
		if (Number(d.status) !== 2) pending.push(`Dice #${i}`);
	}
	for (let i = 1; i <= totalRoulette; i++) {
		const d = await roulette.getBetDetails(i);
		const status = Number(d.status) === 2 ? 'RESOLVED' : `PENDING(${d.status})`;
		console.log(`  Roulette #${i}: ${status}, won=${d.won}, result=${d.result}`);
		if (Number(d.status) !== 2) pending.push(`Roulette #${i}`);
	}
	for (let i = 1; i <= totalBJ; i++) {
		const d = await blackjack.getHandDetails(i);
		const b = await blackjack.getHandBase(i);
		const statusNum = Number(d.status);
		const statusStr =
			statusNum === 6 ? 'RESOLVED' : statusNum === 2 ? 'PLAYER_TURN' : `STATUS(${statusNum})`;
		console.log(
			`  Blackjack #${i}: ${statusStr}, result=${d.result}, payout=${ethers.formatUnits(
				b.payout,
				6
			)}`
		);
		if (statusNum !== 6 && statusNum !== 7) pending.push(`Blackjack #${i}`);
	}
	for (let i = 1; i <= totalBac; i++) {
		const d = await baccarat.getBetDetails(i);
		const b = await baccarat.getBetBase(i);
		const status = Number(d.status) === 2 ? 'RESOLVED' : `PENDING(${d.status})`;
		console.log(
			`  Baccarat #${i}: ${status}, won=${d.won}, result=${d.result}, payout=${ethers.formatUnits(
				b.payout,
				6
			)}`
		);
		if (Number(d.status) !== 2) pending.push(`Baccarat #${i}`);
	}
	for (let i = 1; i <= totalSlots; i++) {
		const d = await slots.getSpinDetails(i);
		const b = await slots.getSpinBase(i);
		const status = Number(d.status) === 2 ? 'RESOLVED' : `PENDING(${d.status})`;
		console.log(
			`  Slots #${i}: ${status}, won=${d.won}, reels=[${d.reels}], payout=${ethers.formatUnits(
				b.payout,
				6
			)}`
		);
		if (Number(d.status) !== 2) pending.push(`Slots #${i}`);
	}

	if (pending.length === 0) {
		console.log('\nAll bets resolved via VRF!');
	} else {
		console.log(`\n${pending.length} still pending: ${pending.join(', ')}`);
	}

	// Batch getters
	console.log('\n--- Batch Getters ---');
	console.log(`Dice getUserBetIds: ${(await dice.getUserBetIds(owner.address, 0, 50)).length}`);
	console.log(`Roulette getRecentBetIds: ${(await roulette.getRecentBetIds(0, 50)).length}`);
	console.log(
		`Blackjack getUserHandIds: ${(await blackjack.getUserHandIds(owner.address, 0, 50)).length}`
	);
	console.log(`Baccarat getRecentBetIds: ${(await baccarat.getRecentBetIds(0, 50)).length}`);
	console.log(`Slots getUserSpinIds: ${(await slots.getUserSpinIds(owner.address, 0, 50)).length}`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
