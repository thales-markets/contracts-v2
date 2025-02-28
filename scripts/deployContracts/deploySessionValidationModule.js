const { ethers, upgrades } = require('hardhat');
const { getTargetAddress, setTargetAddress, isTestNetwork, delay } = require('../helpers');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	// Fetch ProtocolDAO address
	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);

	// Whitelisted contract addresses
	const whitelistedContracts = [
		getTargetAddress('SportsAMMV2', network),
		getTargetAddress('FreeBetsHolder', network),
		getTargetAddress('SGPTradingProcessor', network),
		getTargetAddress('LiveTradingProcessor', network),
	];

	// Deploy SessionValidationModule as a proxy
	const SessionValidationModule = await ethers.getContractFactory('SessionValidationModule');
	const sessionValidationModule = await upgrades.deployProxy(
		SessionValidationModule,
		[protocolDAOAddress, whitelistedContracts],
		{ initialOwner: protocolDAOAddress }
	);
	await sessionValidationModule.waitForDeployment();

	const sessionValidationModuleAddress = await sessionValidationModule.getAddress();
	console.log('SessionValidationModule deployed at:', sessionValidationModuleAddress);
	setTargetAddress('SessionValidationModule', network, sessionValidationModuleAddress);

	// Get implementation address
	const sessionValidationModuleImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sessionValidationModuleAddress
	);
	console.log(
		'SessionValidationModule Implementation:',
		sessionValidationModuleImplementationAddress
	);
	setTargetAddress(
		'SessionValidationModuleImplementation',
		network,
		sessionValidationModuleImplementationAddress
	);

	// Get proxy admin address
	const sessionValidationModuleProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sessionValidationModuleAddress
	);
	console.log('SessionValidationModule Proxy Admin:', sessionValidationModuleProxyAdminAddress);
	setTargetAddress(
		'SessionValidationModuleProxyAdmin',
		network,
		sessionValidationModuleProxyAdminAddress
	);

	await delay(5000);

	// Verify the contract
	try {
		await hre.run('verify:verify', {
			address: sessionValidationModuleAddress,
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
