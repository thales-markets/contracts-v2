const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const betAmount = ethers.parseUnits('3', 6);

	// Slots spin
	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);
	await usdc.approve(slotsAddress, betAmount);
	await delay(3000);
	await slots.spin(usdcAddress, betAmount, ethers.ZeroAddress);
	console.log('Slots: spin placed');

	console.log('Waiting 30s...');
	await delay(30000);

	// Check all results
	const roulette = await ethers.getContractAt('Roulette', getTargetAddress('Roulette', network));
	const blackjack = await ethers.getContractAt('Blackjack', getTargetAddress('Blackjack', network));
	const baccarat = await ethers.getContractAt('Baccarat', getTargetAddress('Baccarat', network));
	const dice = await ethers.getContractAt('Dice', getTargetAddress('Dice', network));

	const diceD = await dice.getBetDetails(1);
	console.log(`Dice (freebet): status=${diceD.status}, won=${diceD.won}`);

	const rouletteD = await roulette.getBetDetails(1);
	console.log(`Roulette: status=${rouletteD.status}, won=${rouletteD.won}`);

	const bjD = await blackjack.getHandDetails(1);
	console.log(`Blackjack: status=${bjD.status}, result=${bjD.result}`);

	const bacD = await baccarat.getBetDetails(1);
	console.log(`Baccarat: status=${bacD.status}, won=${bacD.won}`);

	const slotsD = await slots.getSpinDetails(1);
	console.log(`Slots: status=${slotsD.status}, won=${slotsD.won}`);

	console.log('\nAll done.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
