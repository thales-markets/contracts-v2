const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const holderAddress = getTargetAddress('FreeBetsHolder', network);
	const holder = await ethers.getContractAt('FreeBetsHolder', holderAddress);
	const diceAddress = getTargetAddress('Dice', network);
	const dice = await ethers.getContractAt('Dice', diceAddress);

	const betAmount = ethers.parseUnits('3', 6);

	console.log('Owner:', owner.address);
	console.log('Holder USDC balance:', ethers.formatUnits(await usdc.balanceOf(holderAddress), 6));
	console.log('Dice USDC balance:', ethers.formatUnits(await usdc.balanceOf(diceAddress), 6));

	// Fund a fresh freebet
	console.log('\nFunding fresh freebet...');
	await usdc.approve(holderAddress, betAmount);
	await delay(2000);
	await holder.fund(owner.address, usdcAddress, betAmount);
	await delay(3000);
	const freeBetBal = await holder.balancePerUserAndCollateral(owner.address, usdcAddress);
	console.log('Freebet balance after fund:', ethers.formatUnits(freeBetBal, 6));

	// Place a freebet
	console.log('\nPlacing freebet on Dice...');
	const tx = await dice.placeBetWithFreeBet(usdcAddress, betAmount, 0, 11);
	const receipt = await tx.wait();
	const betId = (await dice.nextBetId()) - 1n;
	console.log('FreeBet placed, tx:', receipt.hash);
	console.log('Bet ID:', betId.toString());
	console.log('isFreeBet:', await dice.isFreeBet(betId));

	const holderBalBefore = await usdc.balanceOf(holderAddress);
	const ownerBalBefore = await usdc.balanceOf(owner.address);
	console.log('Holder USDC before cancel:', ethers.formatUnits(holderBalBefore, 6));
	console.log('Owner USDC before cancel:', ethers.formatUnits(ownerBalBefore, 6));

	// Admin cancel immediately (no timeout needed)
	console.log('\nAdmin cancelling freebet...');
	const cancelTx = await dice.adminCancelBet(betId);
	const cancelReceipt = await cancelTx.wait();
	console.log('Cancel tx:', cancelReceipt.hash);

	// Check results
	const betDetails = await dice.getBetDetails(betId);
	const betBase = await dice.getBetBase(betId);
	console.log('\n--- Results ---');
	console.log('Bet status:', betDetails.status.toString(), '(3 = CANCELLED)');
	console.log(
		'Bet payout:',
		ethers.formatUnits(betBase.payout, 6),
		'(should be 0 for freebet cancel)'
	);

	const holderBalAfter = await usdc.balanceOf(holderAddress);
	const ownerBalAfter = await usdc.balanceOf(owner.address);
	console.log('Holder USDC after cancel:', ethers.formatUnits(holderBalAfter, 6));
	console.log('Owner USDC after cancel:', ethers.formatUnits(ownerBalAfter, 6));

	const holderDiff = holderBalAfter - holderBalBefore;
	console.log('Holder received:', ethers.formatUnits(holderDiff, 6), 'USDC (should be 3.0)');
	console.log(
		'Owner USDC diff:',
		ethers.formatUnits(ownerBalAfter - ownerBalBefore, 6),
		'(should be ~0 minus gas)'
	);

	const freeBetBalAfter = await holder.balancePerUserAndCollateral(owner.address, usdcAddress);
	console.log('Owner freebet balance after cancel:', ethers.formatUnits(freeBetBalAfter, 6));

	const expectedFreeBetBal = freeBetBal - betAmount;
	if (holderDiff === betAmount && freeBetBalAfter === expectedFreeBetBal) {
		console.log(
			'\nPASS: Stake returned to holder, user gets nothing, freebet balance not restored'
		);
	} else {
		console.log('\nFAIL: Unexpected balances');
		console.log('  Expected holder diff:', ethers.formatUnits(betAmount, 6));
		console.log('  Expected freebet bal:', ethers.formatUnits(expectedFreeBetBal, 6));
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
