const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const [owner] = await ethers.getSigners();
	// Use a fixed referrer address for testing
	const referrer = { address: '0x0000000000000000000000000000000000C0FFEE' };
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const diceAddress = getTargetAddress('Dice', network);
	const dice = await ethers.getContractAt('Dice', diceAddress);

	const betAmount = ethers.parseUnits('3', 6); // 3 USDC

	console.log('Player (owner):', owner.address);
	console.log('Referrer:', referrer.address);
	console.log('Dice:', diceAddress);
	console.log('Referrals contract:', await dice.referrals());

	// Check initial balances
	const referrerBalBefore = await usdc.balanceOf(referrer.address);
	console.log('\nReferrer USDC before:', ethers.formatUnits(referrerBalBefore, 6));

	// Place bet with referrer
	console.log('\nPlacing bet with referrer...');
	await usdc.approve(diceAddress, betAmount);
	await delay(2000);
	// ROLL_UNDER target 11 — ~50% chance to win
	const tx = await dice.placeBet(usdcAddress, betAmount, 0, 11, referrer.address);
	const receipt = await tx.wait();
	const betId = (await dice.nextBetId()) - 1n;
	console.log('Bet placed, ID:', betId.toString(), 'tx:', receipt.hash);

	// Check that referral was set
	const mockReferralsAddress = await dice.referrals();
	const mockReferrals = await ethers.getContractAt('MockReferrals', mockReferralsAddress);
	const storedReferrer = await mockReferrals.referrals(owner.address);
	console.log('Stored referrer for player:', storedReferrer);
	console.log('Matches:', storedReferrer === referrer.address);

	// Wait for VRF resolution
	console.log('\nWaiting 30s for VRF resolution...');
	await delay(30000);

	// Check bet result
	const betDetails = await dice.getBetDetails(betId);
	const betBase = await dice.getBetBase(betId);
	console.log('\n--- Bet Result ---');
	console.log('Status:', betDetails.status.toString(), '(2 = RESOLVED)');
	console.log('Won:', betDetails.won);
	console.log('Payout:', ethers.formatUnits(betBase.payout, 6));

	const referrerBalAfter = await usdc.balanceOf(referrer.address);
	const referrerDiff = referrerBalAfter - referrerBalBefore;
	console.log('\nReferrer USDC after:', ethers.formatUnits(referrerBalAfter, 6));
	console.log('Referrer received:', ethers.formatUnits(referrerDiff, 6), 'USDC');

	if (!betDetails.won) {
		// Expected referrer fee: 3 * 0.005 = 0.015 USDC
		const expectedFee = (betAmount * 5000000000000000n) / ethers.parseEther('1');
		console.log('Expected referrer fee:', ethers.formatUnits(expectedFee, 6));
		if (referrerDiff === expectedFee) {
			console.log('\nPASS: Referrer received correct fee on losing bet');
		} else {
			console.log('\nFAIL: Unexpected referrer amount');
		}
	} else {
		console.log('\nBet won — referrer should NOT receive fee on winning bets');
		if (referrerDiff === 0n) {
			console.log('PASS: Referrer received nothing on winning bet');
		} else {
			console.log(
				'FAIL: Referrer received',
				ethers.formatUnits(referrerDiff, 6),
				'on a winning bet'
			);
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
