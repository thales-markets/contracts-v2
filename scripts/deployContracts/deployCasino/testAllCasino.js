const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const betAmount = ethers.parseUnits('3', 6);

	console.log('Owner:', owner.address);
	console.log('USDC balance:', ethers.formatUnits(await usdc.balanceOf(owner.address), 6));

	// Test Dice
	const diceAddress = getTargetAddress('Dice', network);
	const dice = await ethers.getContractAt('Dice', diceAddress);
	await usdc.approve(diceAddress, betAmount);
	await delay(2000);
	const diceTx = await dice.placeBet(usdcAddress, betAmount, 0, 11); // ROLL_UNDER, target 11
	const diceReceipt = await diceTx.wait();
	console.log('\nDice bet placed, tx:', diceReceipt.hash);

	// Test Roulette
	const rouletteAddress = getTargetAddress('Roulette', network);
	const roulette = await ethers.getContractAt('Roulette', rouletteAddress);
	await usdc.approve(rouletteAddress, betAmount);
	await delay(2000);
	const rouletteTx = await roulette.placeBet(usdcAddress, betAmount, 1, 0); // RED_BLACK, red
	const rouletteReceipt = await rouletteTx.wait();
	console.log('Roulette bet placed, tx:', rouletteReceipt.hash);

	// Test Blackjack
	const blackjackAddress = getTargetAddress('Blackjack', network);
	const blackjack = await ethers.getContractAt('Blackjack', blackjackAddress);
	await usdc.approve(blackjackAddress, betAmount);
	await delay(2000);
	const bjTx = await blackjack.placeBet(usdcAddress, betAmount);
	const bjReceipt = await bjTx.wait();
	console.log('Blackjack bet placed, tx:', bjReceipt.hash);

	// Test Baccarat
	const baccaratAddress = getTargetAddress('Baccarat', network);
	const baccarat = await ethers.getContractAt('Baccarat', baccaratAddress);
	await usdc.approve(baccaratAddress, betAmount);
	await delay(2000);
	const baccaratTx = await baccarat.placeBet(usdcAddress, betAmount, 0); // PLAYER
	const baccaratReceipt = await baccaratTx.wait();
	console.log('Baccarat bet placed, tx:', baccaratReceipt.hash);

	// Test Slots
	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);
	await usdc.approve(slotsAddress, betAmount);
	await delay(2000);
	const slotsTx = await slots.spin(usdcAddress, betAmount);
	const slotsReceipt = await slotsTx.wait();
	console.log('Slots spin placed, tx:', slotsReceipt.hash);

	console.log('\nAll 5 games tested. Waiting 30s for VRF resolution...');
	await delay(30000);

	// Check results
	console.log('\n--- Results ---');

	const diceBet = await dice.bets(1);
	console.log(
		`Dice: status=${diceBet.status}, won=${diceBet.won}, payout=${ethers.formatUnits(
			diceBet.payout,
			6
		)}`
	);

	const rouletteBet = await roulette.bets(1);
	console.log(
		`Roulette: status=${rouletteBet.status}, won=${rouletteBet.won}, payout=${ethers.formatUnits(
			rouletteBet.payout,
			6
		)}`
	);

	const bjHand = await blackjack.hands(1);
	console.log(
		`Blackjack: status=${bjHand.status}, result=${bjHand.result}, payout=${ethers.formatUnits(
			bjHand.payout,
			6
		)}`
	);

	const baccaratBase = await baccarat.getBetBase(1);
	const baccaratDetails = await baccarat.getBetDetails(1);
	console.log(
		`Baccarat: status=${baccaratDetails.status}, won=${
			baccaratDetails.won
		}, payout=${ethers.formatUnits(baccaratBase.payout, 6)}`
	);

	const slotsSpin = await slots.spins(1);
	console.log(
		`Slots: status=${slotsSpin.status}, won=${slotsSpin.won}, payout=${ethers.formatUnits(
			slotsSpin.payout,
			6
		)}`
	);

	// Test batch getters
	console.log('\n--- Batch getter test ---');
	const diceUserBets = await dice.getUserBets(owner.address, 0, 10);
	console.log(`Dice getUserBets: ${diceUserBets.length} bets`);

	const recentRoulette = await roulette.getRecentBets(0, 10);
	console.log(`Roulette getRecentBets: ${recentRoulette.length} bets`);

	const bjHands = await blackjack.getRecentHands(0, 10);
	console.log(`Blackjack getRecentHands: ${bjHands.length} hands`);

	const baccaratBets = await baccarat.getRecentBets(0, 10);
	console.log(`Baccarat getRecentBets: ${baccaratBets.length} bets`);

	const recentSpins = await slots.getRecentSpins(0, 10);
	console.log(`Slots getRecentSpins: ${recentSpins.length} spins`);

	console.log('\nAll tests complete.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
