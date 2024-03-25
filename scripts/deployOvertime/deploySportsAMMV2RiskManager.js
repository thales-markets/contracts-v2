const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);

	let defaultCap = ethers.parseEther('1000');
	let defaultRiskMultiplier = 3;
	let maxCap = ethers.parseEther('20000');
	let maxRiskMultiplier = 5;

	const sportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManagerDeployed = await upgrades.deployProxy(
		sportsAMMV2RiskManager,
		[
			owner.address,
			sportsAMMV2ManagerAddress,
			defaultCap,
			defaultRiskMultiplier,
			maxCap,
			maxRiskMultiplier,
		],
		{ initialOwner: protocolDAOAddress }
	);
	await sportsAMMV2RiskManagerDeployed.waitForDeployment();

	const sportsAMMV2RiskManagerAddress = await sportsAMMV2RiskManagerDeployed.getAddress();

	console.log('SportsAMMV2RiskManager deployed on:', sportsAMMV2RiskManagerAddress);
	setTargetAddress('SportsAMMV2RiskManager', network, sportsAMMV2RiskManagerAddress);
	await delay(5000);

	const sportsAMMV2RiskManagerImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2RiskManagerAddress
	);
	console.log(
		'SportsAMMV2RiskManager Implementation:',
		sportsAMMV2RiskManagerImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2RiskManagerImplementation',
		network,
		sportsAMMV2RiskManagerImplementationAddress
	);

	const sportsAMMV2RiskManagerProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sportsAMMV2RiskManagerAddress
	);
	console.log('SportsAMMV2RiskManager Proxy Admin:', sportsAMMV2RiskManagerProxyAdminAddress);
	setTargetAddress(
		'SportsAMMV2RiskManagerProxyAdmin',
		network,
		sportsAMMV2RiskManagerProxyAdminAddress
	);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2RiskManagerAddress,
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

function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time);
	});
}
