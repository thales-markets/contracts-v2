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

	const slots = await ethers.getContractFactory('Slots');
	const slotsAddress = getTargetAddress('Slots', network);

	let slotsImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(slotsAddress, slots);

		slotsImplementationAddress = await getImplementationAddress(ethers.provider, slotsAddress);
	} else {
		slotsImplementationAddress = await upgrades.prepareUpgrade(slotsAddress, slots);
	}

	console.log('Slots upgraded');
	console.log('Slots Implementation:', slotsImplementationAddress);
	setTargetAddress('SlotsImplementation', network, slotsImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: slotsImplementationAddress,
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
