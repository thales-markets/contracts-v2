/**
 * One-off: upgrade Keno on optimisticSepolia to the latest impl. Use when Keno is the only
 * proxy that's drifted from source (e.g. after the L3 / role-lockdown changes).
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/upgradeKeno.js \
 *     --network optimisticSepolia
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { getTargetAddress, setTargetAddress } = require('../../helpers');

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const kenoAddr = getTargetAddress('Keno', network);
	if (!kenoAddr) throw new Error('Keno missing in deployments.json');

	console.log(`\nUpgrading Keno @ ${kenoAddr}`);
	const Factory = await ethers.getContractFactory('Keno');
	await upgrades.upgradeProxy(kenoAddr, Factory);
	const implAddr = await getImplementationAddress(ethers.provider, kenoAddr);
	console.log(`  impl: ${implAddr}`);
	setTargetAddress('KenoImplementation', network, implAddr);

	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log('Verify (Keno):', (e.message || '').split('\n')[0]);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
