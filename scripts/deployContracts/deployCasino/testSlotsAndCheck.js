const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const betAmount = ethers.parseUnits('3', 6);

	// Test Slots
	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);
	await usdc.approve(slotsAddress, betAmount);
	await delay(3000);
	const slotsTx = await slots.spin(usdcAddress, betAmount);
	const slotsReceipt = await slotsTx.wait();
	console.log('Slots spin placed, tx:', slotsReceipt.hash);

	console.log('\nWaiting 30s for VRF...');
	await delay(30000);

	// Check all results
	console.log('\n--- Results ---');
	const dice = await ethers.getContractAt('Dice', getTargetAddress('Dice', network));
	const roulette = await ethers.getContractAt('Roulette', getTargetAddress('Roulette', network));
	const blackjack = await ethers.getContractAt('Blackjack', getTargetAddress('Blackjack', network));
	const baccarat = await ethers.getContractAt('Baccarat', getTargetAddress('Baccarat', network));

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
	console.log('\n--- Batch getters ---');
	const userDice = await dice.getUserBets(owner.address, 0, 10);
	console.log(`Dice getUserBets: ${userDice.length} bets`);
	const recentRoulette = await roulette.getRecentBets(0, 10);
	console.log(`Roulette getRecentBets: ${recentRoulette.length} bets`);
	const bjViews = await blackjack.getRecentHands(0, 10);
	console.log(`Blackjack getRecentHands: ${bjViews.length} hands`);
	const bacViews = await baccarat.getRecentBets(0, 10);
	console.log(`Baccarat getRecentBets: ${bacViews.length} bets`);
	const slotsViews = await slots.getRecentSpins(0, 10);
	console.log(`Slots getRecentSpins: ${slotsViews.length} spins`);

	console.log('\nAll tests complete.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
