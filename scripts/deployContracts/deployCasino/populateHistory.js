const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const bet = ethers.parseUnits('3', 6);

	const diceAddr = getTargetAddress('Dice', network);
	const rouletteAddr = getTargetAddress('Roulette', network);
	const blackjackAddr = getTargetAddress('Blackjack', network);
	const baccaratAddr = getTargetAddress('Baccarat', network);
	const slotsAddr = getTargetAddress('Slots', network);

	const dice = await ethers.getContractAt('Dice', diceAddr);
	const roulette = await ethers.getContractAt('Roulette', rouletteAddr);
	const blackjack = await ethers.getContractAt('Blackjack', blackjackAddr);
	const baccarat = await ethers.getContractAt('Baccarat', baccaratAddr);
	const slots = await ethers.getContractAt('Slots', slotsAddr);

	// Approve all at once
	const totalPerGame = bet * 5n;
	console.log('Approving USDC for all games...');
	await usdc.approve(diceAddr, totalPerGame);
	await delay(2000);
	await usdc.approve(rouletteAddr, totalPerGame);
	await delay(2000);
	await usdc.approve(blackjackAddr, totalPerGame);
	await delay(2000);
	await usdc.approve(baccaratAddr, totalPerGame);
	await delay(2000);
	await usdc.approve(slotsAddr, totalPerGame);
	await delay(2000);
	console.log('All approved\n');

	// === BATCH 1 ===
	console.log('=== Batch 1: Placing 5 bets (one per game) ===');

	await dice.placeBet(usdcAddress, bet, 0, 11); // ROLL_UNDER target 11
	console.log('Dice: ROLL_UNDER target=11');
	await delay(2000);

	await roulette.placeBet(usdcAddress, bet, 1, 0); // RED_BLACK, red
	console.log('Roulette: RED_BLACK red');
	await delay(2000);

	await blackjack.placeBet(usdcAddress, bet);
	console.log('Blackjack: deal');
	await delay(2000);

	await baccarat.placeBet(usdcAddress, bet, 0); // PLAYER
	console.log('Baccarat: PLAYER');
	await delay(2000);

	await slots.spin(usdcAddress, bet);
	console.log('Slots: spin');

	console.log('\nWaiting 30s for VRF...');
	await delay(30000);

	// Check batch 1
	console.log('\n--- Batch 1 Results ---');
	const nextDice = Number(await dice.nextBetId());
	const diceD = await dice.getBetDetails(nextDice - 1);
	const diceB = await dice.getBetBase(nextDice - 1);
	console.log(
		`Dice #${nextDice - 1}: won=${diceD.won}, result=${diceD.result}, payout=${ethers.formatUnits(
			diceB.payout,
			6
		)}`
	);

	const nextRoulette = Number(await roulette.nextBetId());
	const rouletteD = await roulette.getBetDetails(nextRoulette - 1);
	console.log(`Roulette #${nextRoulette - 1}: won=${rouletteD.won}, result=${rouletteD.result}`);

	const nextBJ = Number(await blackjack.nextHandId());
	const bjD = await blackjack.getHandDetails(nextBJ - 1);
	console.log(`Blackjack #${nextBJ - 1}: status=${bjD.status}, result=${bjD.result}`);

	const nextBac = Number(await baccarat.nextBetId());
	const bacD = await baccarat.getBetDetails(nextBac - 1);
	console.log(`Baccarat #${nextBac - 1}: won=${bacD.won}, result=${bacD.result}`);

	const nextSlots = Number(await slots.nextSpinId());
	const slotsD = await slots.getSpinDetails(nextSlots - 1);
	console.log(`Slots #${nextSlots - 1}: won=${slotsD.won}, reels=[${slotsD.reels}]`);

	// === BATCH 2 ===
	console.log('\n=== Batch 2: More variety ===');

	await dice.placeBet(usdcAddress, bet, 1, 10); // ROLL_OVER target 10
	console.log('Dice: ROLL_OVER target=10');
	await delay(2000);

	await roulette.placeBet(usdcAddress, bet, 0, 7); // STRAIGHT on 7
	console.log('Roulette: STRAIGHT on 7');
	await delay(2000);

	await baccarat.placeBet(usdcAddress, bet, 1); // BANKER
	console.log('Baccarat: BANKER');
	await delay(2000);

	await slots.spin(usdcAddress, bet);
	console.log('Slots: spin');
	await delay(2000);

	await dice.placeBet(usdcAddress, bet, 0, 5); // ROLL_UNDER target 5
	console.log('Dice: ROLL_UNDER target=5 (high risk)');

	console.log('\nWaiting 30s for VRF...');
	await delay(30000);

	// Check batch 2
	console.log('\n--- Batch 2 Results ---');
	const nd2 = Number(await dice.nextBetId());
	for (let i = nd2 - 2; i < nd2; i++) {
		const d = await dice.getBetDetails(i);
		const b = await dice.getBetBase(i);
		console.log(
			`Dice #${i}: won=${d.won}, result=${d.result}, target=${
				d.target
			}, payout=${ethers.formatUnits(b.payout, 6)}`
		);
	}

	const nr2 = Number(await roulette.nextBetId());
	const rd2 = await roulette.getBetDetails(nr2 - 1);
	console.log(
		`Roulette #${nr2 - 1}: won=${rd2.won}, result=${rd2.result}, selection=${rd2.selection}`
	);

	const nb2 = Number(await baccarat.nextBetId());
	const bd2 = await baccarat.getBetDetails(nb2 - 1);
	console.log(`Baccarat #${nb2 - 1}: won=${bd2.won}, result=${bd2.result}`);

	const ns2 = Number(await slots.nextSpinId());
	const sd2 = await slots.getSpinDetails(ns2 - 1);
	console.log(`Slots #${ns2 - 1}: won=${sd2.won}, reels=[${sd2.reels}]`);

	// === BATCH 3 ===
	console.log('\n=== Batch 3: More bets ===');

	await roulette.placeBet(usdcAddress, bet, 2, 0); // ODD_EVEN, odd
	console.log('Roulette: ODD_EVEN odd');
	await delay(2000);

	await roulette.placeBet(usdcAddress, bet, 3, 1); // LOW_HIGH, high
	console.log('Roulette: LOW_HIGH high');
	await delay(2000);

	await baccarat.placeBet(usdcAddress, bet, 2); // TIE
	console.log('Baccarat: TIE');
	await delay(2000);

	await dice.placeBet(usdcAddress, bet, 1, 15); // ROLL_OVER target 15
	console.log('Dice: ROLL_OVER target=15');
	await delay(2000);

	await slots.spin(usdcAddress, bet);
	console.log('Slots: spin');

	console.log('\nWaiting 30s for VRF...');
	await delay(30000);

	// Final summary
	console.log('\n=== Final Summary ===');
	const totalDice = Number(await dice.nextBetId()) - 1;
	const totalRoulette = Number(await roulette.nextBetId()) - 1;
	const totalBJ = Number(await blackjack.nextHandId()) - 1;
	const totalBac = Number(await baccarat.nextBetId()) - 1;
	const totalSlots = Number(await slots.nextSpinId()) - 1;

	console.log(`Dice: ${totalDice} bets`);
	console.log(`Roulette: ${totalRoulette} bets`);
	console.log(`Blackjack: ${totalBJ} hands`);
	console.log(`Baccarat: ${totalBac} bets`);
	console.log(`Slots: ${totalSlots} spins`);

	// Check all resolved
	let allResolved = true;
	for (let i = 1; i <= totalDice; i++) {
		const d = await dice.getBetDetails(i);
		if (Number(d.status) !== 2) {
			console.log(`  Dice #${i}: NOT resolved (status=${d.status})`);
			allResolved = false;
		}
	}
	for (let i = 1; i <= totalRoulette; i++) {
		const d = await roulette.getBetDetails(i);
		if (Number(d.status) !== 2) {
			console.log(`  Roulette #${i}: NOT resolved (status=${d.status})`);
			allResolved = false;
		}
	}
	for (let i = 1; i <= totalBJ; i++) {
		const d = await blackjack.getHandDetails(i);
		// Blackjack resolved statuses: 6=RESOLVED, 7=CANCELLED. PLAYER_TURN=2 means needs action
		if (Number(d.status) !== 6 && Number(d.status) !== 7) {
			console.log(`  Blackjack #${i}: NOT resolved (status=${d.status})`);
			allResolved = false;
		}
	}
	for (let i = 1; i <= totalBac; i++) {
		const d = await baccarat.getBetDetails(i);
		if (Number(d.status) !== 2) {
			console.log(`  Baccarat #${i}: NOT resolved (status=${d.status})`);
			allResolved = false;
		}
	}
	for (let i = 1; i <= totalSlots; i++) {
		const d = await slots.getSpinDetails(i);
		if (Number(d.status) !== 2) {
			console.log(`  Slots #${i}: NOT resolved (status=${d.status})`);
			allResolved = false;
		}
	}

	if (allResolved) {
		console.log('\nAll bets resolved via VRF!');
	} else {
		console.log('\nSome bets still pending - VRF may need more time');
	}

	// Test batch getters
	console.log('\n--- Batch Getter Test ---');
	const userDiceIds = await dice.getUserBetIds(owner.address, 0, 50);
	console.log(`Dice getUserBetIds: ${userDiceIds.length} IDs`);
	const recentRouletteIds = await roulette.getRecentBetIds(0, 50);
	console.log(`Roulette getRecentBetIds: ${recentRouletteIds.length} IDs`);
	const userBJIds = await blackjack.getUserHandIds(owner.address, 0, 50);
	console.log(`Blackjack getUserHandIds: ${userBJIds.length} IDs`);
	const recentBacIds = await baccarat.getRecentBetIds(0, 50);
	console.log(`Baccarat getRecentBetIds: ${recentBacIds.length} IDs`);
	const userSlotIds = await slots.getUserSpinIds(owner.address, 0, 50);
	console.log(`Slots getUserSpinIds: ${userSlotIds.length} IDs`);

	console.log('\nDone!');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
