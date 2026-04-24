const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const baccarat = await ethers.getContractFactory('Baccarat');
	const baccaratAddress = getTargetAddress('Baccarat', network);

	let baccaratImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(baccaratAddress, baccarat);

		baccaratImplementationAddress = await getImplementationAddress(
			ethers.provider,
			baccaratAddress
		);
	} else {
		baccaratImplementationAddress = await upgrades.prepareUpgrade(baccaratAddress, baccarat);
	}

	console.log('Baccarat upgraded');
	console.log('Baccarat Implementation:', baccaratImplementationAddress);
	setTargetAddress('BaccaratImplementation', network, baccaratImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: baccaratImplementationAddress,
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
