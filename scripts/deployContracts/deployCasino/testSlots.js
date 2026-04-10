const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const slotsAddress = getTargetAddress('Slots', network);
	const usdcAddress = getTargetAddress('DefaultCollateral', network);

	const slots = await ethers.getContractAt('Slots', slotsAddress);
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);

	// Check current state
	console.log('\n--- Slots Contract State ---');
	console.log('Owner:', await slots.owner());
	console.log('Next Spin ID:', await slots.nextSpinId());
	console.log('Symbol Count:', await slots.symbolCount());
	console.log('Max Profit USD:', ethers.formatEther(await slots.maxProfitUsd()));
	console.log('House Edge:', ethers.formatEther(await slots.houseEdge()));
	console.log('Max Payout Multiplier:', ethers.formatEther(await slots.maxPayoutMultiplier()));

	// Check balances
	const ownerUsdcBal = await usdc.balanceOf(owner.address);
	const slotsUsdcBal = await usdc.balanceOf(slotsAddress);
	console.log('\nOwner USDC balance:', ethers.formatUnits(ownerUsdcBal, 6));
	console.log('Slots USDC balance (bankroll):', ethers.formatUnits(slotsUsdcBal, 6));

	// Fund bankroll if needed
	if (slotsUsdcBal < ethers.parseUnits('100', 6)) {
		const fundAmount = ethers.parseUnits('500', 6);
		if (ownerUsdcBal >= fundAmount) {
			console.log('\nFunding bankroll with 500 USDC...');
			const fundTx = await usdc.transfer(slotsAddress, fundAmount);
			await fundTx.wait();
			console.log(
				'Bankroll funded. New balance:',
				ethers.formatUnits(await usdc.balanceOf(slotsAddress), 6)
			);
		} else {
			console.log(
				'\nInsufficient USDC to fund bankroll. Owner has:',
				ethers.formatUnits(ownerUsdcBal, 6)
			);
		}
	}

	// Approve and spin
	const betAmount = ethers.parseUnits('3', 6); // $3 min bet
	const currentBalance = await usdc.balanceOf(owner.address);

	if (currentBalance >= betAmount) {
		console.log('\n--- Placing Test Spin ---');
		console.log('Bet amount:', ethers.formatUnits(betAmount, 6), 'USDC');

		// Approve
		const approveTx = await usdc.approve(slotsAddress, betAmount);
		await approveTx.wait();
		console.log('Approved');

		await delay(3000);

		// Spin
		try {
			// Try static call first to get revert reason
			try {
				await slots.spin.staticCall(usdcAddress, betAmount);
			} catch (staticErr) {
				console.log('Static call revert reason:', staticErr.reason || staticErr.message);
			}
			const spinTx = await slots.spin(usdcAddress, betAmount, ethers.ZeroAddress);
			const receipt = await spinTx.wait();
			console.log('Spin tx hash:', receipt.hash);

			// Parse SpinPlaced event
			const spinEvent = receipt.logs
				.map((log) => {
					try {
						return slots.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'SpinPlaced');

			if (spinEvent) {
				console.log('Spin ID:', spinEvent.args.spinId.toString());
				console.log('VRF Request ID:', spinEvent.args.requestId.toString());
				console.log('\nSpin placed successfully! Awaiting VRF fulfillment...');
				console.log('Check spin status later with: slots.spins(' + spinEvent.args.spinId + ')');
			}
		} catch (e) {
			console.log('Spin failed:', e.message);
		}
	} else {
		console.log(
			'\nInsufficient USDC for test spin. Balance:',
			ethers.formatUnits(currentBalance, 6)
		);
	}

	// Check available liquidity
	try {
		const liq = await slots.getAvailableLiquidity(usdcAddress);
		console.log('\nAvailable USDC liquidity:', ethers.formatUnits(liq, 6));
	} catch (e) {
		console.log('Could not check liquidity:', e.message);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
