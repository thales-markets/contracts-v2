/**
 * Production deploy of the V2 casino stack. Chain-agnostic — runs identically on
 * optimisticEthereum / arbitrumOne / baseMainnet by reading per-chain config from
 * `scripts/deployments.json`.
 *
 * Differences vs `deployCasinoV2All.js` (testnet):
 *   - Deployed unpaused: bets are impossible until VRF consumer + FBH whitelist + bankroll
 *     are wired by the respective owners (placeBet reverts at `requestRandomWords` / `useFreeBet`
 *     / `reserveOrRevert` otherwise), so an explicit pause is unnecessary.
 *   - VRF config: matches V1 casino games (callbackGasLimit=500_000, requestConfirmations=1,
 *     nativePayment=true). VRF subscription owner is a separate wallet — they must
 *     `addConsumer(subId, newCore)` after this script finishes.
 *   - No bankroll seed: USDC / OVER / WETH funding is done by the operator (no `mintForUser`,
 *     no transfers).
 *   - Multisig ownership handoff: at the end, the signer nominates `ProtocolDAO` (= multisig)
 *     as new owner on all 9 contracts. PDAO must then call `acceptOwnership()` on each.
 *   - Proxy admin: `initialOwner: ProtocolDAO` so the ProxyAdmin is multisig-owned from day 1.
 *   - Idempotent: if any V2 contract is already present in deployments.json, that step is
 *     skipped. Safe to re-run after a partial failure.
 *
 * Caps / risk config (matches the live testnet deployment):
 *   - Global maxProfitUsd = $1000
 *   - cancelTimeout = 600s (operational SLA only — V2 has no user-callable cancel)
 *   - Keno maxBetUsd = $20
 *   - ThreeCardPoker / VideoPoker / OvertimeUltimateHoldem / OvertimeBonusHoldem maxBetUsd = $50
 *   - HiLo / Plinko: no per-game maxBet (global applies)
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/deployCasinoV2Prod.js \
 *     --network <optimisticEthereum|arbitrumOne|baseMainnet>
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

// --- Networks this script supports (chainId for sanity check) ---
const SUPPORTED_PROD = {
	optimisticEthereum: 10n,
	arbitrumOne: 42161n,
	baseMainnet: 8453n,
};

// --- Risk + VRF config (matches testnet + V1 casino games on each prod chain) ---
const MAX_PROFIT_USD = ethers.parseEther('1000');
const CANCEL_TIMEOUT = 600;
const VRF_CALLBACK_GAS_LIMIT = 500_000; // matches V1 Dice/Roulette/Blackjack/Baccarat/Slots
const VRF_REQUEST_CONFIRMATIONS = 1;
const VRF_NATIVE_PAYMENT = true;

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');

const MAX_BET_PER_GAME = {
	ThreeCardPoker: ethers.parseEther('50'),
	VideoPoker: ethers.parseEther('50'),
	OvertimeUltimateHoldem: ethers.parseEther('50'),
	OvertimeBonusHoldem: ethers.parseEther('50'),
	Keno: ethers.parseEther('20'),
};

const GAMES = [
	{ key: 'ThreeCardPoker', slot: 0 },
	{ key: 'Plinko', slot: 1 },
	{ key: 'HiLo', slot: 2 },
	{ key: 'Keno', slot: 3 },
	{ key: 'OvertimeUltimateHoldem', slot: 4 },
	{ key: 'VideoPoker', slot: 5 },
	{ key: 'OvertimeBonusHoldem', slot: 6 },
];

const REQUIRED_DEPS = [
	'ProtocolDAO',
	'SportsAMMV2Manager',
	'PriceFeed',
	'VRFCoordinator',
	'VRFSubscriptionId',
	'VRFKeyHash',
	'FreeBetsHolder',
	'Referrals',
	'DefaultCollateral', // USDC
	'WETH',
	'OVER',
];

const STEP_DELAY = 2000;

async function preflight(signer, network) {
	const chainId = (await ethers.provider.getNetwork()).chainId;
	if (!SUPPORTED_PROD[network] || SUPPORTED_PROD[network] !== chainId) {
		throw new Error(
			`Refusing to deploy: --network=${network} (chainId ${chainId}) is not in the supported prod list: ${Object.keys(
				SUPPORTED_PROD
			).join(', ')}`
		);
	}
	console.log(`Network: ${network} (chainId ${chainId})`);
	console.log(`Signer:  ${signer.address}`);
	console.log(
		`Balance: ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} ETH\n`
	);

	console.log('Required deployments.json entries:');
	for (const k of REQUIRED_DEPS) {
		const v = getTargetAddress(k, network);
		if (!v) throw new Error(`MISSING: deployments.json[${network}].${k}`);
		console.log(`  ${k.padEnd(24)}= ${v}`);
	}
	const bal = await ethers.provider.getBalance(signer.address);
	if (bal < ethers.parseEther('0.005')) {
		throw new Error(`Signer balance below 0.005 ETH safety floor: ${ethers.formatEther(bal)}`);
	}
}

async function deployCore(signer, network) {
	console.log('\n--- 1. CasinoCoreV2 ---');
	const existing = getTargetAddress('CasinoCoreV2', network);
	if (existing) {
		console.log(`  already at ${existing} — skipping deploy/init/pause`);
		return existing;
	}

	const protocolDAO = getTargetAddress('ProtocolDAO', network);

	const Factory = await ethers.getContractFactory('CasinoCoreV2');
	const proxy = await upgrades.deployProxy(Factory, [], {
		initializer: false,
		initialOwner: protocolDAO, // ProxyAdmin owned by PDAO multisig from day 1
	});
	await proxy.waitForDeployment();
	const addr = await proxy.getAddress();
	console.log(`  proxy: ${addr}`);
	setTargetAddress('CasinoCoreV2', network, addr);
	await delay(STEP_DELAY);

	let tx = await proxy.initialize(
		{
			owner: signer.address, // signer is contract owner during setup; nominated to PDAO at end
			manager: getTargetAddress('SportsAMMV2Manager', network),
			priceFeed: getTargetAddress('PriceFeed', network),
			vrfCoordinator: getTargetAddress('VRFCoordinator', network),
			freeBetsHolder: getTargetAddress('FreeBetsHolder', network),
			referrals: getTargetAddress('Referrals', network),
		},
		{
			usdc: getTargetAddress('DefaultCollateral', network),
			weth: getTargetAddress('WETH', network),
			over: getTargetAddress('OVER', network),
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		{
			subscriptionId: BigInt(getTargetAddress('VRFSubscriptionId', network)),
			keyHash: getTargetAddress('VRFKeyHash', network),
			callbackGasLimit: VRF_CALLBACK_GAS_LIMIT,
			requestConfirmations: VRF_REQUEST_CONFIRMATIONS,
			nativePayment: VRF_NATIVE_PAYMENT,
		}
	);
	await tx.wait();
	console.log(
		`  initialized (maxProfit=$${ethers.formatEther(
			MAX_PROFIT_USD
		)}, cancelTimeout=${CANCEL_TIMEOUT}s, VRF callbackGas=${VRF_CALLBACK_GAS_LIMIT})`
	);
	await delay(STEP_DELAY);

	setTargetAddress(
		'CasinoCoreV2Implementation',
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress('CasinoCoreV2ProxyAdmin', network, await getAdminAddress(ethers.provider, addr));
	return addr;
}

async function deployGame(signer, factoryName, coreAddr, managerAddr, network) {
	console.log(`\n--- ${factoryName} ---`);
	const existing = getTargetAddress(factoryName, network);
	if (existing) {
		console.log(`  already at ${existing} — skipping`);
		return existing;
	}

	const protocolDAO = getTargetAddress('ProtocolDAO', network);

	// Atomic deploy+init: deploy proxy AND call initialize in one tx, eliminating the
	// proxy-init front-run attack window (e.g., the 0x6971... bot on op-mainnet that targets
	// the standard initialize(address) signature). `initialOwner: protocolDAO` puts the
	// ProxyAdmin under the multisig from day 1
	const Factory = await ethers.getContractFactory(factoryName);
	const proxy = await upgrades.deployProxy(Factory, [signer.address, coreAddr, managerAddr], {
		initialOwner: protocolDAO,
	});
	await proxy.waitForDeployment();
	const addr = await proxy.getAddress();
	console.log(`  proxy: ${addr} (deployed + initialized atomically)`);
	setTargetAddress(factoryName, network, addr);
	await delay(STEP_DELAY);

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	let tx = await core.registerGame(addr);
	await tx.wait();
	console.log('  registered with core');
	await delay(STEP_DELAY);

	setTargetAddress(
		`${factoryName}Implementation`,
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress(
		`${factoryName}ProxyAdmin`,
		network,
		await getAdminAddress(ethers.provider, addr)
	);

	const maxBet = MAX_BET_PER_GAME[factoryName];
	if (maxBet && maxBet > 0n) {
		tx = await core.setMaxBetPerGameUsd(addr, maxBet);
		await tx.wait();
		console.log(`  maxBetPerGameUsd = $${ethers.formatEther(maxBet)}`);
		await delay(STEP_DELAY);
	}
	return addr;
}

async function deployData(signer, coreAddr, gameAddrs, network) {
	console.log('\n--- CasinoDataV2 ---');
	const existing = getTargetAddress('CasinoDataV2', network);
	if (existing) {
		console.log(`  already at ${existing} — skipping deploy/init/wire`);
		return existing;
	}

	const protocolDAO = getTargetAddress('ProtocolDAO', network);

	// Atomic deploy+init (see deployGame comment for rationale — CasinoDataV2 was the contract
	// hit by the proxy-init front-run on op-mainnet because it has the standard
	// `initialize(address)` signature the bot targets)
	const Factory = await ethers.getContractFactory('CasinoDataV2');
	const proxy = await upgrades.deployProxy(Factory, [signer.address], {
		initialOwner: protocolDAO,
	});
	await proxy.waitForDeployment();
	const addr = await proxy.getAddress();
	console.log(`  proxy: ${addr} (deployed + initialized atomically)`);
	setTargetAddress('CasinoDataV2', network, addr);
	await delay(STEP_DELAY);

	let tx = await proxy.setAddress(0, true, coreAddr);
	await tx.wait();
	console.log('  setAddress(core)');
	await delay(STEP_DELAY);

	for (const { key, slot } of GAMES) {
		tx = await proxy.setAddress(slot, false, gameAddrs[key]);
		await tx.wait();
		console.log(`  setAddress(${key}) slot=${slot}`);
		await delay(STEP_DELAY);
	}

	setTargetAddress(
		'CasinoDataV2Implementation',
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress('CasinoDataV2ProxyAdmin', network, await getAdminAddress(ethers.provider, addr));
	return addr;
}

async function nominateOwners(signer, network, addresses) {
	const protocolDAO = getTargetAddress('ProtocolDAO', network);
	console.log(`\n--- Nominate ProtocolDAO (${protocolDAO}) as new owner ---`);
	for (const [name, addr] of Object.entries(addresses)) {
		const c = new ethers.Contract(
			addr,
			[
				'function owner() view returns (address)',
				'function nominatedOwner() view returns (address)',
				'function nominateNewOwner(address) external',
			],
			signer
		);
		const owner = await c.owner();
		if (owner.toLowerCase() !== signer.address.toLowerCase()) {
			console.log(`  ${name}: current owner ${owner} ≠ signer — skipping`);
			continue;
		}
		const nominated = await c.nominatedOwner();
		if (nominated.toLowerCase() === protocolDAO.toLowerCase()) {
			console.log(`  ${name}: already nominated to PDAO — skipping`);
			continue;
		}
		const tx = await c.nominateNewOwner(protocolDAO);
		await tx.wait();
		console.log(`  ${name}: nominated → ${protocolDAO}`);
		await delay(STEP_DELAY);
	}
}

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;

	console.log('==============================================');
	console.log('  V2 CASINO — PRODUCTION DEPLOY');
	console.log('==============================================');
	await preflight(signer, network);

	const managerAddr = getTargetAddress('SportsAMMV2Manager', network);
	const coreAddr = await deployCore(signer, network);

	const gameAddrs = {};
	for (const { key } of GAMES) {
		gameAddrs[key] = await deployGame(signer, key, coreAddr, managerAddr, network);
	}

	const dataAddr = await deployData(signer, coreAddr, gameAddrs, network);

	await nominateOwners(signer, network, {
		CasinoCoreV2: coreAddr,
		...gameAddrs,
		CasinoDataV2: dataAddr,
	});

	console.log('\n==============================================');
	console.log('  DEPLOYED');
	console.log('==============================================');
	console.log(`CasinoCoreV2 :  ${coreAddr}`);
	for (const { key } of GAMES) console.log(`  ${key.padEnd(24)}: ${gameAddrs[key]}`);
	console.log(`CasinoDataV2 :  ${dataAddr}`);
	console.log('\n==============================================');
	console.log('  POST-DEPLOY (manual, in order):');
	console.log('==============================================');
	console.log(`1. (PDAO multisig) acceptOwnership() on each of the 9 contracts`);
	console.log(
		`2. (VRF sub owner) addConsumer(${getTargetAddress(
			'VRFSubscriptionId',
			network
		)}, ${coreAddr}) on VRFCoordinator ${getTargetAddress('VRFCoordinator', network)}`
	);
	console.log(
		`3. (FBH owner) setWhitelistedCasino(${coreAddr}, true) on FreeBetsHolder ${getTargetAddress(
			'FreeBetsHolder',
			network
		)}`
	);
	console.log(`4. (Operator) fund CasinoCoreV2 with USDC / OVER / WETH as desired`);
	console.log(`   Contracts are deployed unpaused — placeBet is gated on VRF + FBH + bankroll`);
	console.log(`   being wired (otherwise it reverts at requestRandomWords / useFreeBet /`);
	console.log(`   reserveOrRevert), so no explicit unpause step is needed.`);
	console.log('==============================================\n');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
