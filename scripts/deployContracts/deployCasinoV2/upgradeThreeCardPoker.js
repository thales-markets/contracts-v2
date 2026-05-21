/**
 * One-off: upgrade ThreeCardPoker on optimisticSepolia to the latest impl. Use after removing
 * the PLAYER_TURN_TIMEOUT / adminForceFold mechanism so the on-chain surface matches source.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/upgradeThreeCardPoker.js \
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

	const tcpAddr = getTargetAddress('ThreeCardPoker', network);
	if (!tcpAddr) throw new Error('ThreeCardPoker missing in deployments.json');

	console.log(`\nUpgrading ThreeCardPoker @ ${tcpAddr}`);
	const Factory = await ethers.getContractFactory('ThreeCardPoker');
	await upgrades.upgradeProxy(tcpAddr, Factory);
	const implAddr = await getImplementationAddress(ethers.provider, tcpAddr);
	console.log(`  impl: ${implAddr}`);
	setTargetAddress('ThreeCardPokerImplementation', network, implAddr);

	try {
		await hre.run('verify:verify', { address: implAddr });
	} catch (e) {
		console.log('Verify (ThreeCardPoker):', (e.message || '').split('\n')[0]);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
