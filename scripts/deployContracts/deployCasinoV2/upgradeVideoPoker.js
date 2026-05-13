/**
 * One-off: upgrade VideoPoker on optimisticSepolia to the post-paytable-fix impl.
 * Fix details: see project memory `videopoker-paytable-fix` — `_resolve` no longer adds
 * stake-back on win; `MAX_PAYOUT_MULT` 501 → 500.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/upgradeVideoPoker.js \
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

	const vpAddr = getTargetAddress('VideoPoker', network);
	if (!vpAddr) throw new Error('VideoPoker missing in deployments.json');

	console.log(`\nUpgrading VideoPoker @ ${vpAddr}`);
	const Factory = await ethers.getContractFactory('VideoPoker');
	await upgrades.upgradeProxy(vpAddr, Factory);
	const implAddr = await getImplementationAddress(ethers.provider, vpAddr);
	console.log(`  impl: ${implAddr}`);
	setTargetAddress('VideoPokerImplementation', network, implAddr);

	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log('Verify (VideoPoker):', (e.message || '').split('\n')[0]);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
