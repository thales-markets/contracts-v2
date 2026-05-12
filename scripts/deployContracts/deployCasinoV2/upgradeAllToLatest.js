/**
 * Brings every V2 casino contract on Sepolia to the latest source: upgrades the existing
 * proxies (Core, TCP, Hold'em, Plinko, HiLo, CasinoDataV2) and deploys Keno fresh if missing.
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/upgradeAllToLatest.js \
 *     --network optimisticSepolia
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

// Per-game maxProfitUsd overrides. For poker games (TCP, VideoPoker, OvertimeUltimateHoldem)
// this is now a SOFT CAP: bets above the implicit limit are accepted but per-hand net profit
// is truncated. For other games it's a hard cap at placeBet
const GAME_OVERRIDES = {
	HiLo: 0n,
	Plinko: 0n,
	ThreeCardPoker: ethers.parseEther('2000'),
	Keno: ethers.parseEther('1000'),
	VideoPoker: ethers.parseEther('2000'),
	OvertimeUltimateHoldem: ethers.parseEther('2000'),
};

// Per-game min/max ante in USD-18-dec (0 = no override). Frontend quick-pick buttons live here
const MIN_BET_OVERRIDES = {
	ThreeCardPoker: 0n,
	VideoPoker: 0n,
	OvertimeUltimateHoldem: 0n,
};
const MAX_BET_OVERRIDES = {
	ThreeCardPoker: ethers.parseEther('50'),
	VideoPoker: ethers.parseEther('50'),
	OvertimeUltimateHoldem: ethers.parseEther('50'),
};

const STEP_DELAY = 8000;

async function upgradeOne(network, key, factoryName, factoryOpts) {
	const proxyAddr = getTargetAddress(key, network);
	if (!proxyAddr) {
		console.log(`${key}: not in deployments.json — skipping upgrade (use deploy step)`);
		return null;
	}
	console.log(`\nUpgrading ${key} @ ${proxyAddr}`);
	const Factory = await ethers.getContractFactory(factoryName, factoryOpts);
	const upgradeOpts = factoryOpts ? { unsafeAllowLinkedLibraries: true } : undefined;
	await upgrades.upgradeProxy(proxyAddr, Factory, upgradeOpts);
	const implAddr = await getImplementationAddress(ethers.provider, proxyAddr);
	console.log(`  impl: ${implAddr}`);
	setTargetAddress(`${key}Implementation`, network, implAddr);
	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log(`  Verify (${key}):`, (e.message || '').split('\n')[0]);
	}
	await delay(STEP_DELAY);
	return implAddr;
}

async function deployKenoIfMissing(network, owner, coreAddr, managerAddr) {
	return _deployIfMissing(network, owner, coreAddr, managerAddr, 'Keno', 'Keno');
}

async function deployVideoPokerIfMissing(network, owner, coreAddr, managerAddr) {
	return _deployIfMissing(network, owner, coreAddr, managerAddr, 'VideoPoker', 'VideoPoker');
}

async function deployUltimateHoldemIfMissing(network, owner, coreAddr, managerAddr) {
	return _deployIfMissing(
		network,
		owner,
		coreAddr,
		managerAddr,
		'OvertimeUltimateHoldem',
		'OvertimeUltimateHoldem'
	);
}

async function _deployIfMissing(network, owner, coreAddr, managerAddr, factoryName, key) {
	const existing = getTargetAddress(key, network);
	if (existing) {
		console.log(`${key} already at ${existing} — skipping deploy`);
		return existing;
	}
	console.log(`\nDeploying ${key} proxy fresh`);
	const Factory = await ethers.getContractFactory(factoryName);
	const deployed = await upgrades.deployProxy(Factory, [], { initializer: false });
	await deployed.waitForDeployment();
	const addr = await deployed.getAddress();
	console.log(`  ${key} proxy: ${addr}`);
	setTargetAddress(key, network, addr);
	await delay(STEP_DELAY);

	const initTx = await deployed.initialize(owner.address, coreAddr, managerAddr);
	await initTx.wait();
	console.log(`  ${key} initialized`);
	await delay(STEP_DELAY);

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	if (!(await core.isGameRegistered(addr))) {
		const tx = await core.registerGame(addr);
		await tx.wait();
		console.log(`  Registered ${key} with core (tx ${tx.hash})`);
		await delay(STEP_DELAY);
	}

	const implAddr = await getImplementationAddress(ethers.provider, addr);
	setTargetAddress(`${key}Implementation`, network, implAddr);
	setTargetAddress(`${key}ProxyAdmin`, network, await getAdminAddress(ethers.provider, addr));
	console.log(`  ${key} impl: ${implAddr}`);

	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log(`  Verify (${key}):`, (e.message || '').split('\n')[0]);
	}
	await delay(STEP_DELAY);
	return addr;
}

async function ensureDataWiredToKeno(network, dataAddr, kenoAddr) {
	const data = await ethers.getContractAt('CasinoDataV2', dataAddr);
	const current = await data.keno();
	if (current.toLowerCase() === kenoAddr.toLowerCase()) {
		console.log('CasinoDataV2.keno already wired — skipping');
		return;
	}
	const tx = await data.setKeno(kenoAddr);
	await tx.wait();
	console.log(`CasinoDataV2.setKeno(${kenoAddr})  tx=${tx.hash}`);
	await delay(STEP_DELAY);
}

async function ensureDataWiredToUltimateHoldem(network, dataAddr, uthAddr) {
	const data = await ethers.getContractAt('CasinoDataV2', dataAddr);
	let current = ethers.ZeroAddress;
	try {
		current = await data.ultimateHoldem();
	} catch {
		console.log('CasinoDataV2.ultimateHoldem getter missing — skipping (impl not yet upgraded)');
		return;
	}
	if (current.toLowerCase() === uthAddr.toLowerCase()) {
		console.log('CasinoDataV2.ultimateHoldem already wired — skipping');
		return;
	}
	const tx = await data.setUltimateHoldem(uthAddr);
	await tx.wait();
	console.log(`CasinoDataV2.setUltimateHoldem(${uthAddr})  tx=${tx.hash}`);
	await delay(STEP_DELAY);
}

async function ensureDataWiredToVideoPoker(network, dataAddr, vpAddr) {
	const data = await ethers.getContractAt('CasinoDataV2', dataAddr);
	// VideoPoker setter may not exist yet on CasinoDataV2 (parallel work in progress).
	// Best-effort: only call if the setter is present
	if (typeof data.setVideoPoker !== 'function') {
		console.log('CasinoDataV2.setVideoPoker not present — skipping');
		return;
	}
	let current = ethers.ZeroAddress;
	try {
		current = await data.videoPoker();
	} catch {
		// getter doesn't exist either — skip
		console.log('CasinoDataV2.videoPoker getter missing — skipping');
		return;
	}
	if (current.toLowerCase() === vpAddr.toLowerCase()) {
		console.log('CasinoDataV2.videoPoker already wired — skipping');
		return;
	}
	const tx = await data.setVideoPoker(vpAddr);
	await tx.wait();
	console.log(`CasinoDataV2.setVideoPoker(${vpAddr})  tx=${tx.hash}`);
	await delay(STEP_DELAY);
}

async function applyOverrides(network, coreAddr, addresses) {
	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	for (const [name, value] of Object.entries(GAME_OVERRIDES)) {
		const gameAddr = addresses[name];
		if (!gameAddr) continue;
		const before = await core.maxProfitUsdOverride(gameAddr);
		if (before === value) {
			console.log(`  ${name} maxProfitUsd: already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMaxProfitUsdOverride(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${name} maxProfitUsd: $${ethers.formatEther(before)} → $${ethers.formatEther(value)}  tx=${
				tx.hash
			}`
		);
		await delay(STEP_DELAY);
	}
	for (const [name, value] of Object.entries(MIN_BET_OVERRIDES)) {
		const gameAddr = addresses[name];
		if (!gameAddr) continue;
		const before = await core.minBetPerGameUsd(gameAddr);
		if (before === value) {
			console.log(`  ${name} minBetUsd: already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMinBetPerGameUsd(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${name} minBetUsd: $${ethers.formatEther(before)} → $${ethers.formatEther(value)}  tx=${
				tx.hash
			}`
		);
		await delay(STEP_DELAY);
	}
	for (const [name, value] of Object.entries(MAX_BET_OVERRIDES)) {
		const gameAddr = addresses[name];
		if (!gameAddr) continue;
		const before = await core.maxBetPerGameUsd(gameAddr);
		if (before === value) {
			console.log(`  ${name} maxBetUsd: already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMaxBetPerGameUsd(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${name} maxBetUsd: $${ethers.formatEther(before)} → $${ethers.formatEther(value)}  tx=${
				tx.hash
			}`
		);
		await delay(STEP_DELAY);
	}
}

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	const managerAddr = getTargetAddress('SportsAMMV2Manager', network);
	const dataAddr = getTargetAddress('CasinoDataV2', network);
	if (!coreAddr || !managerAddr || !dataAddr) {
		throw new Error('CasinoCoreV2 / Manager / CasinoDataV2 missing in deployments.json');
	}

	console.log('\n===== Phase 1: upgrade existing proxies =====');
	await upgradeOne(network, 'CasinoCoreV2', 'CasinoCoreV2');
	await upgradeOne(network, 'ThreeCardPoker', 'ThreeCardPoker');
	await upgradeOne(network, 'Plinko', 'Plinko');
	await upgradeOne(network, 'HiLo', 'HiLo');
	await upgradeOne(network, 'Keno', 'Keno');
	await upgradeOne(network, 'VideoPoker', 'VideoPoker');
	await upgradeOne(network, 'OvertimeUltimateHoldem', 'OvertimeUltimateHoldem');
	await upgradeOne(network, 'CasinoDataV2', 'CasinoDataV2');

	console.log('\n===== Phase 2: deploy missing games =====');
	const kenoAddr = await deployKenoIfMissing(network, signer, coreAddr, managerAddr);
	const videoPokerAddr = await deployVideoPokerIfMissing(network, signer, coreAddr, managerAddr);
	const uthAddr = await deployUltimateHoldemIfMissing(network, signer, coreAddr, managerAddr);

	console.log('\n===== Phase 3: wire games into CasinoDataV2 =====');
	await ensureDataWiredToKeno(network, dataAddr, kenoAddr);
	await ensureDataWiredToVideoPoker(network, dataAddr, videoPokerAddr);
	await ensureDataWiredToUltimateHoldem(network, dataAddr, uthAddr);

	console.log('\n===== Phase 4: per-game overrides =====');
	await applyOverrides(network, coreAddr, {
		HiLo: getTargetAddress('HiLo', network),
		Plinko: getTargetAddress('Plinko', network),
		ThreeCardPoker: getTargetAddress('ThreeCardPoker', network),
		Keno: kenoAddr,
		VideoPoker: videoPokerAddr,
		OvertimeUltimateHoldem: uthAddr,
	});

	console.log('\n==== ALL UP-TO-DATE ====');
	for (const k of [
		'CasinoCoreV2',
		'ThreeCardPoker',
		'Plinko',
		'HiLo',
		'Keno',
		'VideoPoker',
		'OvertimeUltimateHoldem',
		'CasinoDataV2',
	]) {
		console.log(`  ${k.padEnd(22)}: ${getTargetAddress(k, network)}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
