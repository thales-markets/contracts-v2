/**
 * One-shot end-to-end deployer for the V2 casino stack:
 *   CasinoCoreV2 → ThreeCardPoker → Plinko → HiLo → Keno → VideoPoker → OvertimeUltimateHoldem → CasinoDataV2
 * Plus per-game maxProfitUsd overrides and a USDC bankroll top-up.
 *
 * Idempotent: skips any contract already in deployments.json. To force a fresh redeploy
 * of the whole stack, delete the relevant keys from deployments.json first (CasinoCoreV2,
 * ThreeCardPoker, Plinko, HiLo, Keno, VideoPoker, OvertimeUltimateHoldem, CasinoDataV2 — and their *Implementation /
 * *ProxyAdmin counterparts).
 *
 * Post-deploy manual steps (printed at the end):
 *   1. Add CasinoCoreV2 as a Chainlink VRF consumer on the configured subscription.
 *   2. Whitelist CasinoCoreV2 on the FreeBetsHolder.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/deployCasinoV2All.js \
 *     --network optimisticSepolia
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

// ---------------------------------------------------------------------------
// Risk / config defaults applied at init. Tune via setters post-deploy
// ---------------------------------------------------------------------------
const INITIAL_MAX_PROFIT_USD = ethers.parseEther('300'); // global per-bet profit cap
const INITIAL_CANCEL_TIMEOUT = 60; // seconds before a stuck VRF can be user-cancelled
const VRF_CALLBACK_GAS_LIMIT = 1_000_000;
const VRF_REQUEST_CONFIRMATIONS = 1;
const VRF_NATIVE_PAYMENT = true; // V1+V2 casino convention — pay VRF in native ETH

// Per-game maxProfitUsd overrides (0 = no override, fall back to global).
// For non-poker games this is a hard cap at placeBet — used to gate worst-case payout.
// For poker games (TCP, VideoPoker, OvertimeUltimateHoldem) it's a SOFT CAP applied at
// settle: bets above the cap-implied stake are accepted, but the per-hand net profit is
// truncated so the house never loses more than this USD value on a single hand
const GAME_OVERRIDES = {
	HiLo: 0n, // 25x cap × $300 = $12.50 max bet — global is fine
	Plinko: 0n, // 8-row HIGH 29x × $300 = $10.71 max bet — global is fine
	ThreeCardPoker: ethers.parseEther('2000'), // soft cap: max $2000 net profit per hand
	Keno: ethers.parseEther('1000'), // 100x cap × $10 max bet → $1000 max payout per bet
	VideoPoker: ethers.parseEther('2000'), // soft cap: max $2000 net profit per hand
	OvertimeUltimateHoldem: ethers.parseEther('2000'), // soft cap: max $2000 net profit per hand
};

// Per-game min/max ante in USD-18-dec (0 = no override). Frontend quick-pick buttons should
// fall in this range. For poker games we cap ante at $50; combined with the $2000 profit cap
// this gives a usable bet range without ever exceeding house exposure
const MIN_BET_OVERRIDES = {
	ThreeCardPoker: 0n, // global $3
	VideoPoker: 0n,
	OvertimeUltimateHoldem: 0n,
};
const MAX_BET_OVERRIDES = {
	ThreeCardPoker: ethers.parseEther('50'),
	VideoPoker: ethers.parseEther('50'),
	OvertimeUltimateHoldem: ethers.parseEther('50'),
};

// USDC bankroll seed for core (6 decimals)
const USDC_BANKROLL = 5_000n * 1_000_000n; // 5000 USDC

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');

const STEP_DELAY = 8000; // ms between txs to avoid Sepolia mempool replacement-underpriced

async function deployCore(network, owner) {
	const existing = getTargetAddress('CasinoCoreV2', network);
	if (existing) {
		console.log('CasinoCoreV2 already at:', existing, '— skipping deploy');
		return existing;
	}

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);
	const referralsAddress = getTargetAddress('Referrals', network) || ethers.ZeroAddress;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);

	console.log('  Manager       :', sportsAMMV2ManagerAddress);
	console.log('  PriceFeed     :', priceFeedAddress);
	console.log('  VRFCoordinator:', vrfCoordinatorAddress);
	console.log('  FreeBetsHolder:', freeBetsHolderAddress);
	console.log('  Referrals     :', referralsAddress);
	console.log('  USDC          :', usdcAddress);
	console.log('  WETH          :', wethAddress);
	console.log('  OVER          :', overAddress);

	const Core = await ethers.getContractFactory('CasinoCoreV2');
	const deployed = await upgrades.deployProxy(Core, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await deployed.waitForDeployment();
	const addr = await deployed.getAddress();
	console.log('  CasinoCoreV2 proxy:', addr);
	setTargetAddress('CasinoCoreV2', network, addr);
	await delay(STEP_DELAY);

	const tx = await deployed.initialize(
		{
			owner: owner.address,
			manager: sportsAMMV2ManagerAddress,
			priceFeed: priceFeedAddress,
			vrfCoordinator: vrfCoordinatorAddress,
			freeBetsHolder: freeBetsHolderAddress,
			referrals: referralsAddress,
		},
		{
			usdc: usdcAddress,
			weth: wethAddress,
			over: overAddress,
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		INITIAL_MAX_PROFIT_USD,
		INITIAL_CANCEL_TIMEOUT,
		{
			subscriptionId: BigInt(getTargetAddress('VRFSubscriptionId', network)),
			keyHash: getTargetAddress('VRFKeyHash', network),
			callbackGasLimit: VRF_CALLBACK_GAS_LIMIT,
			requestConfirmations: VRF_REQUEST_CONFIRMATIONS,
			nativePayment: VRF_NATIVE_PAYMENT,
		}
	);
	await tx.wait();
	console.log('  Initialized with maxProfit=$' + ethers.formatEther(INITIAL_MAX_PROFIT_USD));

	setTargetAddress(
		'CasinoCoreV2Implementation',
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress('CasinoCoreV2ProxyAdmin', network, await getAdminAddress(ethers.provider, addr));

	try {
		await hre.run('verify:verify', { address: addr });
	} catch (e) {
		console.log('  Verify (core):', e.message);
	}
	await delay(STEP_DELAY);
	return addr;
}

async function deployGame(network, owner, factoryName, key, coreAddr, managerAddr) {
	const existing = getTargetAddress(key, network);
	if (existing) {
		console.log(`${factoryName} already at: ${existing} — skipping`);
		return existing;
	}

	const Factory = await ethers.getContractFactory(factoryName);
	const deployed = await upgrades.deployProxy(Factory, [], { initializer: false });
	await deployed.waitForDeployment();
	const addr = await deployed.getAddress();
	console.log(`  ${factoryName} proxy:`, addr);
	setTargetAddress(key, network, addr);
	await delay(STEP_DELAY);

	let tx = await deployed.initialize(owner.address, coreAddr, managerAddr);
	await tx.wait();

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	tx = await core.registerGame(addr);
	await tx.wait();
	console.log(`  Registered ${factoryName} with core`);

	setTargetAddress(
		`${key}Implementation`,
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress(`${key}ProxyAdmin`, network, await getAdminAddress(ethers.provider, addr));

	try {
		await hre.run('verify:verify', { address: addr });
	} catch (e) {
		console.log(`  Verify (${factoryName}):`, e.message);
	}
	await delay(STEP_DELAY);
	return addr;
}

async function deployData(network, owner, coreAddr, addresses) {
	const existing = getTargetAddress('CasinoDataV2', network);
	if (existing) {
		console.log('CasinoDataV2 already at:', existing, '— skipping deploy');
		return existing;
	}

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const deployed = await upgrades.deployProxy(Data, [], {
		initializer: false,
	});
	await deployed.waitForDeployment();
	const addr = await deployed.getAddress();
	console.log('  CasinoDataV2 proxy:', addr);
	setTargetAddress('CasinoDataV2', network, addr);
	await delay(STEP_DELAY);

	let tx = await deployed.initialize(owner.address);
	await tx.wait();
	console.log('  CasinoDataV2 initialized');
	await delay(STEP_DELAY);

	tx = await deployed.setAddress(0, true, coreAddr);
	await tx.wait();
	console.log('  setAddress(core)');
	await delay(STEP_DELAY);

	tx = await deployed.setAddress(0, false, addresses.ThreeCardPoker);
	await tx.wait();
	console.log('  setAddress(ThreeCardPoker)');
	await delay(STEP_DELAY);

	tx = await deployed.setAddress(1, false, addresses.Plinko);
	await tx.wait();
	console.log('  setPlinko');
	await delay(STEP_DELAY);

	tx = await deployed.setAddress(2, false, addresses.HiLo);
	await tx.wait();
	console.log('  setHiLo');
	await delay(STEP_DELAY);

	if (addresses.Keno) {
		tx = await deployed.setAddress(3, false, addresses.Keno);
		await tx.wait();
		console.log('  setKeno');
		await delay(STEP_DELAY);
	}

	if (addresses.OvertimeUltimateHoldem) {
		tx = await deployed.setAddress(4, false, addresses.OvertimeUltimateHoldem);
		await tx.wait();
		console.log('  setUltimateHoldem');
		await delay(STEP_DELAY);
	}

	if (addresses.VideoPoker) {
		tx = await deployed.setAddress(5, false, addresses.VideoPoker);
		await tx.wait();
		console.log('  setVideoPoker');
		await delay(STEP_DELAY);
	}

	setTargetAddress(
		'CasinoDataV2Implementation',
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress('CasinoDataV2ProxyAdmin', network, await getAdminAddress(ethers.provider, addr));

	try {
		await hre.run('verify:verify', { address: addr });
	} catch (e) {
		console.log('  Verify (data):', e.message);
	}
	await delay(STEP_DELAY);
	return addr;
}

async function applyOverrides(network, coreAddr, addresses) {
	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	for (const [key, value] of Object.entries(GAME_OVERRIDES)) {
		const gameAddr = addresses[key];
		const before = await core.maxProfitUsdOverride(gameAddr);
		if (before === value) {
			console.log(`  ${key} maxProfitUsd: already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMaxProfitUsdOverride(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${key} maxProfitUsd: $${ethers.formatEther(before)} → $${ethers.formatEther(value)}`
		);
		await delay(STEP_DELAY);
	}
	for (const [key, value] of Object.entries(MIN_BET_OVERRIDES)) {
		const gameAddr = addresses[key];
		if (!gameAddr) continue;
		const before = await core.minBetPerGameUsd(gameAddr);
		if (before === value) {
			console.log(`  ${key} minBetUsd: already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMinBetPerGameUsd(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${key} minBetUsd: $${ethers.formatEther(before)} → $${ethers.formatEther(value)}`
		);
		await delay(STEP_DELAY);
	}
	for (const [key, value] of Object.entries(MAX_BET_OVERRIDES)) {
		const gameAddr = addresses[key];
		if (!gameAddr) continue;
		const before = await core.maxBetPerGameUsd(gameAddr);
		if (before === value) {
			console.log(`  ${key} maxBetUsd: already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMaxBetPerGameUsd(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${key} maxBetUsd: $${ethers.formatEther(before)} → $${ethers.formatEther(value)}`
		);
		await delay(STEP_DELAY);
	}
}

async function topUpBankroll(network, owner, coreAddr) {
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const usdc = await ethers.getContractAt('ExoticUSDC', usdcAddress);
	const balCore = await usdc.balanceOf(coreAddr);
	if (balCore >= USDC_BANKROLL) {
		console.log(`  USDC bankroll already $${(Number(balCore) / 1_000_000).toFixed(2)} — skipped`);
		return;
	}

	const ownerBal = await usdc.balanceOf(owner.address);
	if (ownerBal < USDC_BANKROLL) {
		console.log(
			`  Owner balance $${(Number(ownerBal) / 1_000_000).toFixed(2)} insufficient — minting`
		);
		try {
			const mintTx = await usdc.mintForUser(owner.address);
			await mintTx.wait();
			await delay(STEP_DELAY);
		} catch (e) {
			console.log('  mintForUser failed:', e.shortMessage || e.message);
		}
	}

	const tx = await usdc.transfer(coreAddr, USDC_BANKROLL);
	await tx.wait();
	const newBal = await usdc.balanceOf(coreAddr);
	console.log(
		`  Sent $${(Number(USDC_BANKROLL) / 1_000_000).toFixed(2)} USDC → core; balance now $${(
			Number(newBal) / 1_000_000
		).toFixed(2)}`
	);
}

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;

	console.log('Owner:  ', signer.address);
	console.log('Network:', network);

	console.log('\n--- 1. CasinoCoreV2 ---');
	const coreAddr = await deployCore(network, signer);

	const managerAddr = getTargetAddress('SportsAMMV2Manager', network);

	console.log('\n--- 2. ThreeCardPoker ---');
	const tcpAddr = await deployGame(
		network,
		signer,
		'ThreeCardPoker',
		'ThreeCardPoker',
		coreAddr,
		managerAddr
	);

	console.log('\n--- 3. Plinko ---');
	const plinkoAddr = await deployGame(network, signer, 'Plinko', 'Plinko', coreAddr, managerAddr);

	console.log('\n--- 4. HiLo ---');
	const hiloAddr = await deployGame(network, signer, 'HiLo', 'HiLo', coreAddr, managerAddr);

	console.log('\n--- 5. Keno ---');
	const kenoAddr = await deployGame(network, signer, 'Keno', 'Keno', coreAddr, managerAddr);

	console.log('\n--- 6. VideoPoker ---');
	const videoPokerAddr = await deployGame(
		network,
		signer,
		'VideoPoker',
		'VideoPoker',
		coreAddr,
		managerAddr
	);

	console.log('\n--- 7. OvertimeUltimateHoldem ---');
	const uthAddr = await deployGame(
		network,
		signer,
		'OvertimeUltimateHoldem',
		'OvertimeUltimateHoldem',
		coreAddr,
		managerAddr
	);

	const addresses = {
		ThreeCardPoker: tcpAddr,
		Plinko: plinkoAddr,
		HiLo: hiloAddr,
		Keno: kenoAddr,
		VideoPoker: videoPokerAddr,
		OvertimeUltimateHoldem: uthAddr,
	};

	console.log('\n--- 9. CasinoDataV2 ---');
	const dataAddr = await deployData(network, signer, coreAddr, addresses);

	console.log('\n--- 10. Per-game maxProfitUsd overrides ---');
	await applyOverrides(network, coreAddr, addresses);

	console.log('\n--- 11. USDC bankroll top-up ---');
	await topUpBankroll(network, signer, coreAddr);

	console.log('\n==== DEPLOYED ====');
	console.log('CasinoCoreV2 :', coreAddr);
	console.log('TCP          :', tcpAddr);
	console.log('Plinko       :', plinkoAddr);
	console.log('HiLo         :', hiloAddr);
	console.log('Keno         :', kenoAddr);
	console.log('VideoPoker   :', videoPokerAddr);
	console.log("Ultimate Hold'em:", uthAddr);
	console.log('CasinoDataV2 :', dataAddr);
	console.log('');
	console.log('==== POST-DEPLOY MANUAL STEPS ====');
	console.log(
		'1. Add',
		coreAddr,
		'as a Chainlink VRF consumer on subscription',
		getTargetAddress('VRFSubscriptionId', network)
	);
	console.log(
		'2. Whitelist CasinoCoreV2 on FreeBetsHolder',
		'(',
		getTargetAddress('FreeBetsHolder', network),
		')'
	);
	console.log('====================================');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
