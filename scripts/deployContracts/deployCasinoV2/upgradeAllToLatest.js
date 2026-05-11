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

// Per-game maxProfitUsd overrides — applied after games are registered/upgraded
const GAME_OVERRIDES = {
	HiLo: 0n,
	Plinko: 0n,
	ThreeCardPoker: ethers.parseEther('1000'),
	OvertimeHoldem: ethers.parseEther('3000'),
	Keno: ethers.parseEther('1000'),
};

const STEP_DELAY = 8000;

async function upgradeOne(network, key, factoryName) {
	const proxyAddr = getTargetAddress(key, network);
	if (!proxyAddr) {
		console.log(`${key}: not in deployments.json — skipping upgrade (use deploy step)`);
		return null;
	}
	console.log(`\nUpgrading ${key} @ ${proxyAddr}`);
	const Factory = await ethers.getContractFactory(factoryName);
	await upgrades.upgradeProxy(proxyAddr, Factory);
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
	const existing = getTargetAddress('Keno', network);
	if (existing) {
		console.log(`Keno already at ${existing} — skipping deploy`);
		return existing;
	}
	console.log('\nDeploying Keno proxy fresh');
	const Factory = await ethers.getContractFactory('Keno');
	const deployed = await upgrades.deployProxy(Factory, [], { initializer: false });
	await deployed.waitForDeployment();
	const addr = await deployed.getAddress();
	console.log(`  Keno proxy: ${addr}`);
	setTargetAddress('Keno', network, addr);
	await delay(STEP_DELAY);

	const initTx = await deployed.initialize(owner.address, coreAddr, managerAddr);
	await initTx.wait();
	console.log('  Keno initialized');
	await delay(STEP_DELAY);

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	if (!(await core.isGameRegistered(addr))) {
		const tx = await core.registerGame(addr);
		await tx.wait();
		console.log(`  Registered Keno with core (tx ${tx.hash})`);
		await delay(STEP_DELAY);
	}

	const implAddr = await getImplementationAddress(ethers.provider, addr);
	setTargetAddress('KenoImplementation', network, implAddr);
	setTargetAddress('KenoProxyAdmin', network, await getAdminAddress(ethers.provider, addr));
	console.log(`  Keno impl: ${implAddr}`);

	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log('  Verify (Keno):', (e.message || '').split('\n')[0]);
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

async function applyOverrides(network, coreAddr, addresses) {
	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);
	for (const [name, value] of Object.entries(GAME_OVERRIDES)) {
		const gameAddr = addresses[name];
		if (!gameAddr) continue;
		const before = await core.maxProfitUsdOverride(gameAddr);
		if (before === value) {
			console.log(`  ${name}: override already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx = await core.setMaxProfitUsdOverride(gameAddr, value);
		await tx.wait();
		console.log(
			`  ${name}: override $${ethers.formatEther(before)} → $${ethers.formatEther(value)}  tx=${
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
	await upgradeOne(network, 'OvertimeHoldem', 'OvertimeHoldem');
	await upgradeOne(network, 'Plinko', 'Plinko');
	await upgradeOne(network, 'HiLo', 'HiLo');
	await upgradeOne(network, 'Keno', 'Keno');
	await upgradeOne(network, 'CasinoDataV2', 'CasinoDataV2');

	console.log('\n===== Phase 2: Keno (deploy if missing) =====');
	const kenoAddr = await deployKenoIfMissing(network, signer, coreAddr, managerAddr);

	console.log('\n===== Phase 3: wire Keno into CasinoDataV2 =====');
	await ensureDataWiredToKeno(network, dataAddr, kenoAddr);

	console.log('\n===== Phase 4: per-game overrides =====');
	await applyOverrides(network, coreAddr, {
		HiLo: getTargetAddress('HiLo', network),
		Plinko: getTargetAddress('Plinko', network),
		ThreeCardPoker: getTargetAddress('ThreeCardPoker', network),
		OvertimeHoldem: getTargetAddress('OvertimeHoldem', network),
		Keno: kenoAddr,
	});

	console.log('\n==== ALL UP-TO-DATE ====');
	for (const k of [
		'CasinoCoreV2',
		'ThreeCardPoker',
		'OvertimeHoldem',
		'Plinko',
		'HiLo',
		'Keno',
		'CasinoDataV2',
	]) {
		console.log(`  ${k.padEnd(15)}: ${getTargetAddress(k, network)}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
