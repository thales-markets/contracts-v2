const { ethers } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2DataAddress = getTargetAddress('SportsAMMV2Data', network);
	const SportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);

	const ResolveBlocker = await ethers.getContractFactory('ResolveBlocker');
	const resolveBlockerDeployed = await upgrades.deployProxy(
		ResolveBlocker,
		[owner.address, sportsAMMV2DataAddress, SportsAMMV2ManagerAddress],
		{ initialOwner: protocolDAOAddress }
	);

	await resolveBlockerDeployed.waitForDeployment();

	const resolveBlockerAddress = await resolveBlockerDeployed.getAddress();

	console.log('ResolveBlocker deployed on:', resolveBlockerAddress);
	setTargetAddress('ResolveBlocker', network, resolveBlockerAddress);
	await delay(5000);

	const ResolveBlockerImplementationAddress = await getImplementationAddress(
		ethers.provider,
		resolveBlockerAddress
	);
	console.log('ResolveBlocker Implementation:', ResolveBlockerImplementationAddress);
	setTargetAddress('ResolveBlockerImplementation', network, ResolveBlockerImplementationAddress);

	const ResolveBlockerAdminAddress = await getAdminAddress(ethers.provider, resolveBlockerAddress);
	console.log('ResolveBlocker Proxy Admin:', ResolveBlockerAdminAddress);
	setTargetAddress('ResolveBlockerProxyAdmin', network, ResolveBlockerAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: resolveBlockerAddress,
			contract: 'contracts/core/Resolving/ResolveBlocker.sol:ResolveBlocker',
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
