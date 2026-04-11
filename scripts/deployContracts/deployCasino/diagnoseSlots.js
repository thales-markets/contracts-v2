const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

// Read-only diagnostic: inspects the currently-deployed Slots contract on
// the active network and tries to simulate a 3-USDC spin (same shape as the
// failing frontend tx) to surface any revert reason.

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;

	console.log('Signer:  ', signer.address);
	console.log('Network: ', network);

	const slotsAddress = getTargetAddress('Slots', network);
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);

	console.log('Slots:            ', slotsAddress);
	console.log('USDC:             ', usdcAddress);
	console.log('FreeBetsHolder:   ', freeBetsHolderAddress);

	const slots = await ethers.getContractAt('Slots', slotsAddress);

	// ---------- core state ----------
	console.log('\n========== CORE STATE ==========');
	const paused = await slots.paused();
	const symbolCount = Number(await slots.symbolCount());
	const houseEdge = await slots.houseEdge();
	const maxPayout = await slots.maxPayoutMultiplier();
	const maxProfitUsd = await slots.maxProfitUsd();
	const cancelTimeout = await slots.cancelTimeout();
	const owner = await slots.owner();
	const fbh = await slots.freeBetsHolder();
	const refs = await slots.referrals();
	const nextSpinId = await slots.nextSpinId();

	console.log('owner:             ', owner);
	console.log('paused:            ', paused);
	console.log('symbolCount:       ', symbolCount);
	console.log('houseEdge:         ', ethers.formatEther(houseEdge));
	console.log('maxPayoutMult:     ', ethers.formatEther(maxPayout));
	console.log('maxProfitUsd:      ', ethers.formatEther(maxProfitUsd));
	console.log('cancelTimeout:     ', cancelTimeout.toString(), 's');
	console.log('freeBetsHolder:    ', fbh);
	console.log('referrals:         ', refs);
	console.log('nextSpinId:        ', nextSpinId.toString());

	// ---------- supported collateral ----------
	console.log('\n========== SUPPORTED COLLATERAL ==========');
	console.log('USDC:', await slots.supportedCollateral(usdcAddress));
	console.log('WETH:', await slots.supportedCollateral(wethAddress));
	console.log('OVER:', await slots.supportedCollateral(overAddress));

	// ---------- symbol weights + payouts ----------
	console.log('\n========== GAME MATH ==========');
	for (let i = 0; i < symbolCount; i++) {
		const w = await slots.symbolWeights(i);
		const pair = await slots.pairPayout(i);
		const triple = await slots.triplePayout(i);
		console.log(
			`symbol[${i}]: weight=${w.toString().padStart(3)} ` +
				`pair=${ethers.formatEther(pair)}x triple=${ethers.formatEther(triple)}x`
		);
	}

	// ---------- bankroll & reserved profit ----------
	console.log('\n========== BANKROLL ==========');
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const weth = await ethers.getContractAt('IERC20', wethAddress);
	const over = await ethers.getContractAt('IERC20', overAddress);

	const slotsUsdcBal = await usdc.balanceOf(slotsAddress);
	const slotsWethBal = await weth.balanceOf(slotsAddress);
	const slotsOverBal = await over.balanceOf(slotsAddress);
	console.log(`Slots USDC balance: ${ethers.formatUnits(slotsUsdcBal, 6)} USDC`);
	console.log(`Slots WETH balance: ${ethers.formatEther(slotsWethBal)} WETH`);
	console.log(`Slots OVER balance: ${ethers.formatEther(slotsOverBal)} OVER`);

	const reservedUsdc = await slots.reservedProfitPerCollateral(usdcAddress);
	console.log(`reservedProfit[USDC]: ${ethers.formatUnits(reservedUsdc, 6)} USDC`);
	const availUsdc = await slots.getAvailableLiquidity(usdcAddress);
	console.log(`availableLiquidity[USDC]: ${ethers.formatUnits(availUsdc, 6)} USDC`);

	// ---------- signer balance + allowance ----------
	console.log('\n========== SIGNER ==========');
	const signerUsdcBal = await usdc.balanceOf(signer.address);
	const signerAllowance = await usdc.allowance(signer.address, slotsAddress);
	console.log(`signer USDC balance:   ${ethers.formatUnits(signerUsdcBal, 6)}`);
	console.log(`signer allowance:      ${ethers.formatUnits(signerAllowance, 6)}`);

	// ---------- FreeBetsHolder whitelist for casino ----------
	if (freeBetsHolderAddress && freeBetsHolderAddress !== ethers.ZeroAddress) {
		console.log('\n========== FREEBETSHOLDER WHITELIST ==========');
		try {
			const fbhContract = await ethers.getContractAt('FreeBetsHolder', freeBetsHolderAddress);
			const isWhitelisted = await fbhContract.whitelistedCasino(slotsAddress);
			console.log(`FreeBetsHolder.whitelistedCasino(Slots) = ${isWhitelisted}`);
		} catch (e) {
			console.log('Could not query FreeBetsHolder.whitelistedCasino:', e.message || e);
		}
	}

	// ---------- VRF consumer check ----------
	console.log('\n========== VRF SUBSCRIPTION ==========');
	try {
		const vrfCoordAddr = getTargetAddress('VRFCoordinator', network);
		const subId = BigInt(getTargetAddress('VRFSubscriptionId', network));
		const vrfAbi = [
			'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)',
		];
		const vrf = new ethers.Contract(vrfCoordAddr, vrfAbi, ethers.provider);
		const sub = await vrf.getSubscription(subId);
		console.log('Subscription ID:   ', subId.toString());
		console.log('LINK balance:      ', ethers.formatUnits(sub.balance, 18));
		console.log('Native balance:    ', ethers.formatEther(sub.nativeBalance));
		console.log('Request count:     ', sub.reqCount.toString());
		console.log('Owner:             ', sub.subOwner);
		console.log('Consumers:         ', sub.consumers.length);
		for (const c of sub.consumers) {
			const marker = c.toLowerCase() === slotsAddress.toLowerCase() ? '  <- SLOTS' : '';
			console.log(`   ${c}${marker}`);
		}
		const isConsumer = sub.consumers
			.map((x) => x.toLowerCase())
			.includes(slotsAddress.toLowerCase());
		console.log(`Slots is VRF consumer: ${isConsumer}`);
	} catch (e) {
		console.log('VRF check failed:', e.message || e);
	}

	// ---------- simulate spin() eth_call ----------
	console.log('\n========== SIMULATE spin(USDC, 3e6, 0x0) ==========');
	const spinAmount = 3_000_000n; // 3 USDC
	try {
		const out = await slots.spin.staticCall(usdcAddress, spinAmount, ethers.ZeroAddress, {
			from: signer.address,
		});
		console.log('staticCall OK (would succeed):', out);
	} catch (e) {
		console.log('staticCall reverted:');
		console.log('  message:', e.message || e);
		if (e.data) console.log('  raw data:', e.data);
		if (e.errorName) console.log('  errorName:', e.errorName);
		if (e.revert) console.log('  revert:', JSON.stringify(e.revert));
		// try to decode custom errors via the contract interface
		const raw =
			e.data || (e.error && e.error.data) || (e.info && e.info.error && e.info.error.data);
		if (raw) {
			try {
				const parsed = slots.interface.parseError(raw);
				console.log(
					`  decoded: ${parsed.name}(${parsed.args.map((a) => a.toString()).join(', ')})`
				);
			} catch (_) {
				console.log('  could not decode error via Slots interface');
			}
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
