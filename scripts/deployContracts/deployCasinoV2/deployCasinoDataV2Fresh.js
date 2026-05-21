/**
 * One-off: deploys a fresh `CasinoDataV2` proxy on Sepolia and wires it to all currently-deployed
 * games. Used after a storage-layout-breaking change (e.g. removing a per-game slot) where the
 * existing proxy can't be upgraded in place.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/deployCasinoDataV2Fresh.js \
 *     --network optimisticSepolia
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { getTargetAddress, setTargetAddress, delay } = require('../../helpers');

const STEP_DELAY = 8000;

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	if (!coreAddr) throw new Error('CasinoCoreV2 missing in deployments.json');

	const existing = getTargetAddress('CasinoDataV2', network);
	if (existing) {
		throw new Error(
			`CasinoDataV2 already at ${existing} — remove from deployments.json to force fresh deploy`
		);
	}

	const tcpAddr = getTargetAddress('ThreeCardPoker', network);
	const plinkoAddr = getTargetAddress('Plinko', network);
	const hiloAddr = getTargetAddress('HiLo', network);
	const kenoAddr = getTargetAddress('Keno', network);
	const uthAddr = getTargetAddress('OvertimeUltimateHoldem', network);
	const vpAddr = getTargetAddress('VideoPoker', network);

	console.log('\nDeploying fresh CasinoDataV2');
	const Data = await ethers.getContractFactory('CasinoDataV2');
	const deployed = await upgrades.deployProxy(Data, [], {
		initializer: false,
	});
	await deployed.waitForDeployment();
	const dataAddr = await deployed.getAddress();
	console.log('  CasinoDataV2 proxy:', dataAddr);
	setTargetAddress('CasinoDataV2', network, dataAddr);
	await delay(STEP_DELAY);

	let tx = await deployed.initialize(signer.address);
	await tx.wait();
	console.log('  initialized');
	await delay(STEP_DELAY);

	tx = await deployed.setAddress(0, true, coreAddr);
	await tx.wait();
	console.log('  setAddress(core)');
	await delay(STEP_DELAY);

	if (tcpAddr) {
		tx = await deployed.setAddress(0, false, tcpAddr);
		await tx.wait();
		console.log('  setAddress(ThreeCardPoker)');
		await delay(STEP_DELAY);
	}

	if (plinkoAddr) {
		tx = await deployed.setAddress(1, false, plinkoAddr);
		await tx.wait();
		console.log('  setPlinko');
		await delay(STEP_DELAY);
	}
	if (hiloAddr) {
		tx = await deployed.setAddress(2, false, hiloAddr);
		await tx.wait();
		console.log('  setHiLo');
		await delay(STEP_DELAY);
	}
	if (kenoAddr) {
		tx = await deployed.setAddress(3, false, kenoAddr);
		await tx.wait();
		console.log('  setKeno');
		await delay(STEP_DELAY);
	}
	if (uthAddr) {
		tx = await deployed.setAddress(4, false, uthAddr);
		await tx.wait();
		console.log('  setUltimateHoldem');
		await delay(STEP_DELAY);
	}
	if (vpAddr) {
		tx = await deployed.setAddress(5, false, vpAddr);
		await tx.wait();
		console.log('  setVideoPoker');
		await delay(STEP_DELAY);
	}

	const implAddr = await getImplementationAddress(ethers.provider, dataAddr);
	setTargetAddress('CasinoDataV2Implementation', network, implAddr);
	setTargetAddress(
		'CasinoDataV2ProxyAdmin',
		network,
		await getAdminAddress(ethers.provider, dataAddr)
	);
	console.log('  impl:', implAddr);

	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log('  Verify (CasinoDataV2):', (e.message || '').split('\n')[0]);
	}

	console.log('\n==== DONE ====');
	console.log('CasinoDataV2 :', dataAddr);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
