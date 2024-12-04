const { ethers } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const ResolveBlocker = await ethers.getContractFactory('ResolveBlocker');
	const resolveBlockerAddress = getTargetAddress('ResolveBlocker', network);

	let resolveBlockerImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(resolveBlockerAddress, ResolveBlocker);

		resolveBlockerImplementationAddress = await getImplementationAddress(
			ethers.provider,
			resolveBlockerAddress
		);
	} else {
		resolveBlockerImplementationAddress = await upgrades.prepareUpgrade(
			resolveBlockerAddress,
			ResolveBlocker
		);
	}

	console.log('ResolveBlocker upgraded');
	console.log('ResolveBlocker Implementation:', resolveBlockerImplementationAddress);
	setTargetAddress('ResolveBlockerImplementation', network, resolveBlockerImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: resolveBlockerImplementationAddress,
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
