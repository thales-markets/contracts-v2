const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const thalesTokenAddress = getTargetAddress('THALES', network);
	const overTokenAddress = getTargetAddress('OVER', network);

	// Deploy ThalesToOverMigration
	const ThalesToOverMigration = await ethers.getContractFactory('ThalesToOverMigration');
	const thalesToOverMigrationDeployed = await upgrades.deployProxy(
		ThalesToOverMigration,
		[owner.address, thalesTokenAddress, overTokenAddress],
		{ initialOwner: protocolDAOAddress }
	);
	await thalesToOverMigrationDeployed.waitForDeployment();

	const thalesToOverMigrationAddress = await thalesToOverMigrationDeployed.getAddress();

	console.log('ThalesToOverMigration deployed on:', thalesToOverMigrationAddress);
	setTargetAddress('ThalesToOverMigration', network, thalesToOverMigrationAddress);
	await delay(5000);

	// Get and set implementation address
	const implementationAddress = await getImplementationAddress(
		ethers.provider,
		thalesToOverMigrationAddress
	);
	console.log('ThalesToOverMigration Implementation:', implementationAddress);
	setTargetAddress('ThalesToOverMigrationImplementation', network, implementationAddress);

	// Get and set proxy admin address
	const proxyAdminAddress = await getAdminAddress(ethers.provider, thalesToOverMigrationAddress);
	console.log('ThalesToOverMigration Proxy Admin:', proxyAdminAddress);
	setTargetAddress('ThalesToOverMigrationProxyAdmin', network, proxyAdminAddress);

	await delay(5000);

	// Verify contract on Etherscan
	try {
		await hre.run('verify:verify', {
			address: thalesToOverMigrationAddress,
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
