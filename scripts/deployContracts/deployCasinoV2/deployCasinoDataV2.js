/**
 * Deploys CasinoDataV2 — the read-only aggregator over CasinoCoreV2 + the 6 V2 games.
 * Wires every game it can find in deployments.json
 *
 * Run AFTER all V2 games are deployed (each one sets its key in deployments.json on deploy)
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const coreAddress = getTargetAddress('CasinoCoreV2', network);
	const tcpAddress = getTargetAddress('ThreeCardPoker', network) || ethers.ZeroAddress;

	if (!coreAddress) throw new Error('CasinoCoreV2 not deployed');

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const dataDeployed = await upgrades.deployProxy(Data, [], {
		initializer: false,
		initialOwner: owner.address,
	});
	await dataDeployed.waitForDeployment();
	const dataAddress = await dataDeployed.getAddress();
	console.log('CasinoDataV2 deployed at:', dataAddress);
	setTargetAddress('CasinoDataV2', network, dataAddress);

	await delay(5000);

	await dataDeployed.initialize(owner.address, coreAddress, tcpAddress);
	console.log('CasinoDataV2 initialized');

	await delay(5000);

	// Wire any other deployed V2 games that exist in deployments.json
	const games = [
		{ key: 'OvertimeHoldem', setter: 'setOvertimeHoldem' },
		{ key: 'Plinko', setter: 'setPlinko' },
		{ key: 'Crash', setter: 'setCrash' },
		{ key: 'Mines', setter: 'setMines' },
		{ key: 'HiLo', setter: 'setHiLo' },
	];
	for (const { key, setter } of games) {
		const addr = getTargetAddress(key, network);
		if (addr) {
			const tx = await dataDeployed[setter](addr);
			await tx.wait();
			console.log(`Wired ${key} at ${addr}`);
			await delay(2000);
		} else {
			console.log(`(skipping ${key} — not in deployments.json yet)`);
		}
	}

	const implAddress = await getImplementationAddress(ethers.provider, dataAddress);
	console.log('CasinoDataV2 Implementation:', implAddress);
	setTargetAddress('CasinoDataV2Implementation', network, implAddress);

	const proxyAdminAddress = await getAdminAddress(ethers.provider, dataAddress);
	console.log('CasinoDataV2 ProxyAdmin    :', proxyAdminAddress);
	setTargetAddress('CasinoDataV2ProxyAdmin', network, proxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', { address: dataAddress });
	} catch (e) {
		console.log('Verification failed:', e.message);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
