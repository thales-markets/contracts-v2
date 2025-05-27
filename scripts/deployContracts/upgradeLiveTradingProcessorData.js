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

	const liveTradingProcessorData = await ethers.getContractFactory('LiveTradingProcessorData');
	const liveTradingProcessorDataAddress = getTargetAddress('LiveTradingProcessorData', network);

	let liveTradingProcessorDataImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(liveTradingProcessorDataAddress, liveTradingProcessorData);

		liveTradingProcessorDataImplementationAddress = await getImplementationAddress(
			ethers.provider,
			liveTradingProcessorDataAddress
		);
	} else {
		liveTradingProcessorDataImplementationAddress = await upgrades.prepareUpgrade(
			liveTradingProcessorDataAddress,
			liveTradingProcessorData
		);
	}

	console.log('LiveTradingProcessorData upgraded');
	console.log(
		'LiveTradingProcessorData Implementation:',
		liveTradingProcessorDataImplementationAddress
	);
	setTargetAddress(
		'LiveTradingProcessorDataImplementation',
		network,
		liveTradingProcessorDataImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: liveTradingProcessorDataImplementationAddress,
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
