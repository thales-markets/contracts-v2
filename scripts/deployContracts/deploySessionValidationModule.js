const { ethers, upgrades } = require('hardhat');
const { getTargetAddress, setTargetAddress, isTestNetwork, delay } = require('../helpers');

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

	// Deploy SessionValidationModule
	const SessionValidationModule = await ethers.getContractFactory('SessionValidationModule');
	const sessionValidationModule = await SessionValidationModule.deploy(SessionValidationModule, [
		protocolDAOAddress,
		whitelistedContracts,
	]);
	await sessionValidationModule.deployed();

	const sessionValidationModuleAddress = await sessionValidationModule.getAddress();
	console.log('SessionValidationModule deployed at:', sessionValidationModuleAddress);
	setTargetAddress('SessionValidationModule', network, sessionValidationModuleAddress);

	await delay(5000);

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
