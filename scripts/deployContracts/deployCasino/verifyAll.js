const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const bet = ethers.parseUnits('3', 6);
	const holderAddress = getTargetAddress('FreeBetsHolder', network);

	console.log('Owner:', owner.address);
	console.log('FreeBetsHolder:', holderAddress);

	const dice = await ethers.getContractAt('Dice', getTargetAddress('Dice', network));
	const slots = await ethers.getContractAt('Slots', getTargetAddress('Slots', network));
	const holder = await ethers.getContractAt('FreeBetsHolder', holderAddress);

	// 1. Normal bet on Dice
	console.log('\n--- Normal Dice bet ---');
	await usdc.approve(getTargetAddress('Dice', network), bet);
	await delay(2000);
	await dice.placeBet(usdcAddress, bet, 0, 11, ethers.ZeroAddress);
	console.log('Placed');

	// 2. Fund a free bet via FreeBetsHolder and use on Slots
	console.log('\n--- Free bet on Slots ---');
	await usdc.approve(holderAddress, bet);
	await delay(2000);
	await holder.fund(owner.address, usdcAddress, bet);
	const balBefore = await holder.balancePerUserAndCollateral(owner.address, usdcAddress);
	console.log('Freebet balance:', ethers.formatUnits(balBefore, 6));

	await slots.spinWithFreeBet(usdcAddress, bet);
	const balAfter = await holder.balancePerUserAndCollateral(owner.address, usdcAddress);
	console.log('Freebet balance after spin:', ethers.formatUnits(balAfter, 6));
	console.log('isFreeBet:', await slots.isFreeBet((await slots.nextSpinId()) - 1n));

	// 3. Wait for VRF
	console.log('\nWaiting 25s for VRF...');
	await delay(25000);

	// 4. Check results
	const diceId = (await dice.nextBetId()) - 1n;
	const diceD = await dice.getBetDetails(diceId);
	const diceB = await dice.getBetBase(diceId);
	console.log(
		`\nDice #${diceId}: status=${diceD.status}, won=${diceD.won}, payout=${ethers.formatUnits(
			diceB.payout,
			6
		)}`
	);

	const slotsId = (await slots.nextSpinId()) - 1n;
	const slotsD = await slots.getSpinDetails(slotsId);
	const slotsB = await slots.getSpinBase(slotsId);
	console.log(
		`Slots #${slotsId} (freebet): status=${slotsD.status}, won=${
			slotsD.won
		}, payout=${ethers.formatUnits(slotsB.payout, 6)}`
	);

	if (slotsD.won) {
		const holderBal = await usdc.balanceOf(holderAddress);
		console.log('FreeBetsHolder USDC balance (stake returned):', ethers.formatUnits(holderBal, 6));
	}

	// 5. Verify batch getters still work
	console.log('\n--- Batch getters ---');
	const diceIds = await dice.getUserBetIds(owner.address, 0, 10);
	console.log('Dice getUserBetIds:', diceIds.length);
	const slotsIds = await slots.getUserSpinIds(owner.address, 0, 10);
	console.log('Slots getUserSpinIds:', slotsIds.length);

	console.log('\nAll good.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
