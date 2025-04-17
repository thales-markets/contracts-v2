const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const liveTradingProcessorAddress = getTargetAddress('LiveTradingProcessor', network);

	const liveTradingProcessorData = await ethers.getContractFactory('LiveTradingProcessorData');
	const liveTradingProcessorDataDeployed = await upgrades.deployProxy(
		liveTradingProcessorData,
		[owner.address, liveTradingProcessorAddress],
		{ initialOwner: protocolDAOAddress }
	);
	await liveTradingProcessorDataDeployed.waitForDeployment();

	const liveTradingProcessorDataAddress = await liveTradingProcessorDataDeployed.getAddress();

	console.log('LiveTradingProcessorData deployed on:', liveTradingProcessorDataAddress);
	setTargetAddress('LiveTradingProcessorData', network, liveTradingProcessorDataAddress);
	await delay(5000);

	const liveTradingProcessorDataImplementationAddress = await getImplementationAddress(
		ethers.provider,
		liveTradingProcessorDataAddress
	);
	console.log(
		'LiveTradingProcessorData Implementation:',
		liveTradingProcessorDataImplementationAddress
	);
	setTargetAddress(
		'LiveTradingProcessorDataImplementation',
		network,
		liveTradingProcessorDataImplementationAddress
	);

	const liveTradingProcessorDataProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		liveTradingProcessorDataAddress
	);
	console.log('LiveTradingProcessorData Proxy Admin:', liveTradingProcessorDataProxyAdminAddress);
	setTargetAddress(
		'LiveTradingProcessorDataProxyAdmin',
		network,
		liveTradingProcessorDataProxyAdminAddress
	);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: liveTradingProcessorDataAddress,
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
