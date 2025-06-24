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

	const overdropRewards = await ethers.getContractFactory('OverdropRewards');
	const overdropRewardsAddress = getTargetAddress('OverdropRewards', network);

	let overdropRewardsImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(overdropRewardsAddress, overdropRewards);

		overdropRewardsImplementationAddress = await getImplementationAddress(
			ethers.provider,
			overdropRewardsAddress
		);
	} else {
		overdropRewardsImplementationAddress = await upgrades.prepareUpgrade(
			overdropRewardsAddress,
			overdropRewards
		);
	}

	console.log('OverdropRewards upgraded');
	console.log('OverdropRewards Implementation:', overdropRewardsImplementationAddress);
	setTargetAddress('OverdropRewardsImplementation', network, overdropRewardsImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: overdropRewardsImplementationAddress,
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