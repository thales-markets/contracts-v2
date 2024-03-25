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

	const sportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManagerDeployed = await upgrades.deployProxy(
		sportsAMMV2ResultManager,
		[owner.address, sportsAMMV2ManagerAddress],
		{ initialOwner: protocolDAOAddress }
	);
	await sportsAMMV2ResultManagerDeployed.waitForDeployment();

	const sportsAMMV2ResultManagerAddress = await sportsAMMV2ResultManagerDeployed.getAddress();

	console.log('SportsAMMV2ResultManager deployed on:', sportsAMMV2ResultManagerAddress);
	setTargetAddress('SportsAMMV2ResultManager', network, sportsAMMV2ResultManagerAddress);
	await delay(5000);

	const sportsAMMV2ResultManagerImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2ResultManagerAddress
	);
	console.log(
		'SportsAMMV2ResultManager Implementation:',
		sportsAMMV2ResultManagerImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2ResultManagerImplementation',
		network,
		sportsAMMV2ResultManagerImplementationAddress
	);

	const sportsAMMV2ResultManagerProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sportsAMMV2ResultManagerAddress
	);
	console.log('SportsAMMV2ResultManager Proxy Admin:', sportsAMMV2ResultManagerProxyAdminAddress);
	setTargetAddress(
		'SportsAMMV2ResultManagerProxyAdmin',
		network,
		sportsAMMV2ResultManagerProxyAdminAddress
	);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2ResultManagerAddress,
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
