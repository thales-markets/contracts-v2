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

	const sportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const sportsAMMV2ManagerDeployed = await upgrades.deployProxy(
		sportsAMMV2Manager,
		[owner.address],
		{ initialOwner: protocolDAOAddress }
	);
	await sportsAMMV2ManagerDeployed.waitForDeployment();

	const sportsAMMV2ManagerAddress = await sportsAMMV2ManagerDeployed.getAddress();

	console.log('SportsAMMV2Manager deployed on:', sportsAMMV2ManagerAddress);
	setTargetAddress('SportsAMMV2Manager', network, sportsAMMV2ManagerAddress);
	await delay(5000);

	const sportsAMMV2ManagerImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2ManagerAddress
	);
	console.log('SportsAMMV2Manager Implementation:', sportsAMMV2ManagerImplementationAddress);
	setTargetAddress(
		'SportsAMMV2ManagerImplementation',
		network,
		sportsAMMV2ManagerImplementationAddress
	);

	const sportsAMMV2ManagerProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sportsAMMV2ManagerAddress
	);
	console.log('SportsAMMV2Manager Proxy Admin:', sportsAMMV2ManagerProxyAdminAddress);
	setTargetAddress('SportsAMMV2ManagerProxyAdmin', network, sportsAMMV2ManagerProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2ManagerAddress,
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
