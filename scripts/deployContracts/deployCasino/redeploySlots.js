const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

// ============================================================
// Fresh Slots redeployment (testnet)
// ============================================================
// 1. Pauses the old Slots, admin-cancels any pending spins, withdraws all
//    USDC/WETH/OVER bankroll to the owner.
// 2. Deploys a fresh Slots proxy+implementation and initializes it.
// 3. Configures 5 symbols with pair + triple payouts (new game math).
// 4. Re-wires freeBetsHolder and referrals if they were set on the old contract.
// 5. Transfers the withdrawn bankroll to the new Slots address.
// 6. Updates deployments.json with the new Slots/SlotsImplementation/SlotsProxyAdmin.
//
// New game math:
//   symbolCount = 5
//   symbolWeights = [34, 26, 18, 13, 9]
//   pairPayouts   = [0.5, 0.75, 1.0, 1.25, 1.75]      (raw, net-of-stake)
//   triplePayouts = [2, 4, 10, 20, 38]                (raw, net-of-stake)
//   houseEdge          = 2%
//   maxPayoutMultiplier = 50x
// => Hit rate ~41.56% (1 in 2.41), RTP ~95.05%,
//    min win 1.49x stake, max win 38.24x stake,
//    every triple > every pair.
// ============================================================

const SYMBOL_COUNT = 5;
const SYMBOL_WEIGHTS = [34, 26, 18, 13, 9];
const PAIR_PAYOUTS = [
	ethers.parseEther('0.5'),
	ethers.parseEther('0.75'),
	ethers.parseEther('1'),
	ethers.parseEther('1.25'),
	ethers.parseEther('1.75'),
];
const TRIPLE_PAYOUTS = [
	ethers.parseEther('2'),
	ethers.parseEther('4'),
	ethers.parseEther('10'),
	ethers.parseEther('20'),
	ethers.parseEther('38'),
];

// Lifecycle status constants (match Slots.SpinStatus enum)
const STATUS_PENDING = 1n;

async function sendTx(signer, contract, method, ...args) {
	const nonce = await signer.provider.getTransactionCount(signer.address, 'pending');
	const tx = await contract[method](...args, { nonce });
	await tx.wait(1);
	await delay(3000);
	return tx;
}

async function cancelAllPendingSpins(slots, owner) {
	const nextSpinId = Number(await slots.nextSpinId());
	console.log(`  Scanning ${nextSpinId - 1} historical spins for PENDING...`);

	const pending = [];
	for (let id = 1; id < nextSpinId; id++) {
		const details = await slots.getSpinDetails(id);
		if (details.status === STATUS_PENDING) pending.push(id);
	}

	if (pending.length === 0) {
		console.log('  No pending spins.');
		return;
	}

	console.log(`  Found ${pending.length} pending spin(s): ${pending.join(', ')}`);
	for (const id of pending) {
		await sendTx(owner, slots, 'adminCancelSpin', id);
		console.log(`    cancelled spinId ${id}`);
	}
}

async function withdrawAllCollateral(slots, owner, collaterals) {
	const withdrawn = {};
	for (const { name, address } of collaterals) {
		const token = await ethers.getContractAt('IERC20', address);
		const balance = await token.balanceOf(await slots.getAddress());
		if (balance === 0n) {
			console.log(`  ${name}: nothing to withdraw`);
			withdrawn[name] = { address, amount: 0n };
			continue;
		}
		console.log(`  ${name}: withdrawing ${balance.toString()} (raw units) to owner`);
		await sendTx(owner, slots, 'withdrawCollateral', address, owner.address, balance);
		withdrawn[name] = { address, amount: balance };
	}
	return withdrawn;
}

async function main() {
	const [owner] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;

	console.log('Owner:  ', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	const wethPriceFeedKey = ethers.encodeBytes32String('ETH');
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	const collaterals = [
		{ name: 'USDC', address: usdcAddress },
		{ name: 'WETH', address: wethAddress },
		{ name: 'OVER', address: overAddress },
	];

	// ============================================================
	// STEP 1 — Drain the old Slots contract
	// ============================================================
	const oldSlotsAddress = getTargetAddress('Slots', network);
	console.log('\n========== STEP 1: drain old Slots ==========');
	console.log('Old Slots:', oldSlotsAddress);

	const oldSlots = await ethers.getContractAt('Slots', oldSlotsAddress);

	// Preserve operational parameters from the old deployment
	const oldMaxProfitUsd = await oldSlots.maxProfitUsd();
	const oldCancelTimeout = await oldSlots.cancelTimeout();
	const oldHouseEdge = await oldSlots.houseEdge();
	const oldMaxPayoutMultiplier = await oldSlots.maxPayoutMultiplier();
	console.log('  Preserved params from old Slots:');
	console.log('    maxProfitUsd:        ', ethers.formatEther(oldMaxProfitUsd));
	console.log('    cancelTimeout:       ', oldCancelTimeout.toString() + 's');
	console.log('    houseEdge:           ', ethers.formatEther(oldHouseEdge));
	console.log('    maxPayoutMultiplier: ', ethers.formatEther(oldMaxPayoutMultiplier));

	// The new Slots always points to the main FreeBetsHolder (not the legacy
	// CasinoFreeBetsHolder). Referrals is copied over from the old Slots.
	const mainFreeBetsHolder = getTargetAddress('FreeBetsHolder', network);
	const oldFreeBetsHolder = await oldSlots.freeBetsHolder();
	const oldReferrals = await oldSlots.referrals();
	console.log('  old freeBetsHolder:    ', oldFreeBetsHolder);
	console.log('  main FreeBetsHolder:   ', mainFreeBetsHolder);
	console.log('  referrals (to reuse):  ', oldReferrals);

	const wasPaused = await oldSlots.paused();
	if (!wasPaused) {
		console.log('  Pausing old Slots...');
		await sendTx(owner, oldSlots, 'setPausedByRole', true);
	} else {
		console.log('  Old Slots already paused');
	}

	console.log('  Cancelling pending spins...');
	await cancelAllPendingSpins(oldSlots, owner);

	console.log('  Withdrawing bankroll...');
	const withdrawn = await withdrawAllCollateral(oldSlots, owner, collaterals);

	// ============================================================
	// STEP 2 — Deploy fresh Slots
	// ============================================================
	console.log('\n========== STEP 2: deploy fresh Slots ==========');
	const SlotsFactory = await ethers.getContractFactory('Slots');
	const slotsDeployed = await upgrades.deployProxy(SlotsFactory, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await slotsDeployed.waitForDeployment();

	const slotsAddress = await slotsDeployed.getAddress();
	console.log('  New Slots proxy:', slotsAddress);
	setTargetAddress('Slots', network, slotsAddress);

	await delay(5000);

	await sendTx(
		owner,
		slotsDeployed,
		'initialize',
		{
			owner: owner.address,
			manager: sportsAMMV2ManagerAddress,
			priceFeed: priceFeedAddress,
			vrfCoordinator: vrfCoordinatorAddress,
		},
		{
			usdc: usdcAddress,
			weth: wethAddress,
			over: overAddress,
			wethPriceFeedKey,
			overPriceFeedKey,
		},
		oldMaxProfitUsd, // preserve from old Slots
		oldCancelTimeout, // preserve from old Slots
		oldHouseEdge, // preserve from old Slots
		oldMaxPayoutMultiplier, // preserve from old Slots
		{
			subscriptionId: BigInt(getTargetAddress('VRFSubscriptionId', network)),
			keyHash: getTargetAddress('VRFKeyHash', network),
			callbackGasLimit: 500000,
			requestConfirmations: 1,
			nativePayment: false,
		}
	);
	console.log('  Initialized');

	// ============================================================
	// STEP 3 — Configure game math
	// ============================================================
	console.log('\n========== STEP 3: configure game math ==========');
	await sendTx(owner, slotsDeployed, 'setSymbols', SYMBOL_COUNT, SYMBOL_WEIGHTS);
	console.log(
		`  Symbols configured: count=${SYMBOL_COUNT}, weights=[${SYMBOL_WEIGHTS.join(', ')}]`
	);

	for (let i = 0; i < PAIR_PAYOUTS.length; i++) {
		await sendTx(owner, slotsDeployed, 'setPairPayout', i, PAIR_PAYOUTS[i]);
		console.log(`  pairPayout[${i}]   = ${ethers.formatEther(PAIR_PAYOUTS[i])}x`);
	}
	for (let i = 0; i < TRIPLE_PAYOUTS.length; i++) {
		await sendTx(owner, slotsDeployed, 'setTriplePayout', i, TRIPLE_PAYOUTS[i]);
		console.log(`  triplePayout[${i}] = ${ethers.formatEther(TRIPLE_PAYOUTS[i])}x`);
	}

	// ============================================================
	// STEP 4 — Re-wire FreeBetsHolder (main, not legacy Casino one) and Referrals
	// ============================================================
	console.log('\n========== STEP 4: re-wire external contracts ==========');
	if (mainFreeBetsHolder && mainFreeBetsHolder !== ethers.ZeroAddress) {
		await sendTx(owner, slotsDeployed, 'setFreeBetsHolder', mainFreeBetsHolder);
		console.log('  freeBetsHolder set to', mainFreeBetsHolder, '(main FreeBetsHolder)');
	} else {
		console.log('  WARNING: FreeBetsHolder not found in deployments.json, skipping');
	}
	if (oldReferrals !== ethers.ZeroAddress) {
		await sendTx(owner, slotsDeployed, 'setReferrals', oldReferrals);
		console.log('  referrals set to', oldReferrals);
	}

	// The main FreeBetsHolder tracks whitelisted casinos. The new Slots address
	// needs to be whitelisted there (and the old one un-whitelisted). That setter
	// is onlyOwner on the holder and must be called as a separate admin action.
	if (mainFreeBetsHolder && mainFreeBetsHolder !== ethers.ZeroAddress) {
		console.log(
			`  TODO: on FreeBetsHolder (${mainFreeBetsHolder}), call ` +
				`setWhitelistedCasino(${slotsAddress}, true) and ` +
				`setWhitelistedCasino(${oldSlotsAddress}, false)`
		);
	}

	// ============================================================
	// STEP 5 — Fund new Slots with withdrawn bankroll
	// ============================================================
	console.log('\n========== STEP 5: transfer bankroll to new Slots ==========');
	for (const name of Object.keys(withdrawn)) {
		const { address, amount } = withdrawn[name];
		if (amount === 0n) {
			console.log(`  ${name}: nothing to transfer`);
			continue;
		}
		const token = await ethers.getContractAt('IERC20', address);
		const nonce = await owner.provider.getTransactionCount(owner.address, 'pending');
		const tx = await token.transfer(slotsAddress, amount, { nonce });
		await tx.wait(1);
		await delay(3000);
		console.log(`  ${name}: transferred ${amount.toString()} (raw units)`);
	}

	// ============================================================
	// STEP 6 — Record implementation + proxy admin
	// ============================================================
	const slotsImplementationAddress = await getImplementationAddress(ethers.provider, slotsAddress);
	setTargetAddress('SlotsImplementation', network, slotsImplementationAddress);
	console.log('\nSlots Implementation:', slotsImplementationAddress);

	const slotsProxyAdminAddress = await getAdminAddress(ethers.provider, slotsAddress);
	setTargetAddress('SlotsProxyAdmin', network, slotsProxyAdminAddress);
	console.log('Slots Proxy Admin:   ', slotsProxyAdminAddress);

	await delay(5000);

	// ============================================================
	// STEP 7 — Source verification (best effort)
	// ============================================================
	try {
		await hre.run('verify:verify', { address: slotsAddress });
	} catch (e) {
		console.log('verify (proxy) failed:', e.message || e);
	}

	// ============================================================
	// VERIFICATION
	// ============================================================
	console.log('\n========== VERIFICATION ==========');
	const finalSymbolCount = Number(await slotsDeployed.symbolCount());
	const finalWeights = [];
	for (let i = 0; i < finalSymbolCount; i++) {
		finalWeights.push(Number(await slotsDeployed.symbolWeights(i)));
	}
	console.log(`  symbolCount:   ${finalSymbolCount}`);
	console.log(`  symbolWeights: [${finalWeights.join(', ')}]`);

	const totalWeight = finalWeights.reduce((a, b) => a + b, 0);
	const p = finalWeights.map((w) => w / totalWeight);
	const houseEdgeNum = Number(ethers.formatEther(await slotsDeployed.houseEdge()));

	let hitRate = 0;
	let rtp = 0;
	for (let i = 0; i < finalSymbolCount; i++) {
		const pair = Number(ethers.formatEther(await slotsDeployed.pairPayout(i)));
		const triple = Number(ethers.formatEther(await slotsDeployed.triplePayout(i)));
		const pairProb = 2 * p[i] * p[i] * (1 - p[i]); // excludes triples
		const tripleProb = p[i] ** 3;
		hitRate += pairProb + tripleProb;
		rtp += pairProb * (1 + (1 - houseEdgeNum) * pair);
		rtp += tripleProb * (1 + (1 - houseEdgeNum) * triple);
		console.log(
			`  symbol ${i}: weight ${finalWeights[i]}, pair ${pair}x (${(pairProb * 100).toFixed(
				3
			)}%), ` + `triple ${triple}x (${(tripleProb * 100).toFixed(4)}%)`
		);
	}
	console.log(`  Hit rate:   ${(hitRate * 100).toFixed(2)}% (1 in ${(1 / hitRate).toFixed(2)})`);
	console.log(`  RTP:        ${(rtp * 100).toFixed(2)}%`);
	console.log(`  House edge: ${((1 - rtp) * 100).toFixed(2)}%`);

	console.log('\n========== BANKROLL ==========');
	for (const { name, address } of collaterals) {
		const token = await ethers.getContractAt('IERC20', address);
		const bal = await token.balanceOf(slotsAddress);
		console.log(`  ${name}: ${bal.toString()} (raw units)`);
	}

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
