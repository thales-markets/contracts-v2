const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);

	const sportsAMMV2LiquidityPoolData = await ethers.getContractFactory(
		'SportsAMMV2LiquidityPoolData'
	);
	const sportsAMMV2LiquidityPoolDataDeployed = await upgrades.deployProxy(
		sportsAMMV2LiquidityPoolData,
		[owner.address],
		{ initialOwner: protocolDAOAddress }
	);
	await sportsAMMV2LiquidityPoolDataDeployed.waitForDeployment();

	const sportsAMMV2LiquidityPoolDataAddress =
		await sportsAMMV2LiquidityPoolDataDeployed.getAddress();

	console.log('SportsAMMV2LiquidityPoolData deployed on:', sportsAMMV2LiquidityPoolDataAddress);
	setTargetAddress('SportsAMMV2LiquidityPoolData', network, sportsAMMV2LiquidityPoolDataAddress);
	await delay(5000);

	const sportsAMMV2LiquidityPoolDataImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2LiquidityPoolDataAddress
	);
	console.log(
		'SportsAMMV2LiquidityPoolData Implementation:',
		sportsAMMV2LiquidityPoolDataImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolDataImplementation',
		network,
		sportsAMMV2LiquidityPoolDataImplementationAddress
	);

	const sportsAMMV2LiquidityPoolDataProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sportsAMMV2LiquidityPoolDataAddress
	);
	console.log(
		'SportsAMMV2LiquidityPoolData Proxy Admin:',
		sportsAMMV2LiquidityPoolDataProxyAdminAddress
	);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolDataProxyAdmin',
		network,
		sportsAMMV2LiquidityPoolDataProxyAdminAddress
	);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2LiquidityPoolDataAddress,
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
