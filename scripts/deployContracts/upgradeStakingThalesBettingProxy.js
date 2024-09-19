const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const stakingThalesBettingProxy = await ethers.getContractFactory('StakingThalesBettingProxy');
	const stakingThalesBettingProxyAddress = getTargetAddress('StakingThalesBettingProxy', network);

	let stakingThalesBettingProxyImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(stakingThalesBettingProxyAddress, stakingThalesBettingProxy);

		stakingThalesBettingProxyImplementationAddress = await getImplementationAddress(
			ethers.provider,
			stakingThalesBettingProxyAddress
		);
	} else {
		stakingThalesBettingProxyImplementationAddress = await upgrades.prepareUpgrade(
			stakingThalesBettingProxyAddress,
			stakingThalesBettingProxy
		);
	}

	console.log('StakingThalesBettingProxy upgraded');
	console.log(
		'StakingThalesBettingProxy Implementation:',
		stakingThalesBettingProxyImplementationAddress
	);
	setTargetAddress(
		'StakingThalesBettingProxyImplementation',
		network,
		stakingThalesBettingProxyImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: stakingThalesBettingProxyImplementationAddress,
		});
	} catch (e) {
		console.log(e);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
