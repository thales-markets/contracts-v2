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

	const freeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);

	let freeBetsHolderImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(freeBetsHolderAddress, freeBetsHolder);

		freeBetsHolderImplementationAddress = await getImplementationAddress(
			ethers.provider,
			freeBetsHolderAddress
		);
	} else {
		freeBetsHolderImplementationAddress = await upgrades.prepareUpgrade(
			freeBetsHolderAddress,
			freeBetsHolder
		);
	}

	console.log('FreeBetsHolder upgraded');
	console.log('FreeBetsHolder Implementation:', freeBetsHolderImplementationAddress);
	setTargetAddress('FreeBetsHolderImplementation', network, freeBetsHolderImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: freeBetsHolderImplementationAddress,
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
