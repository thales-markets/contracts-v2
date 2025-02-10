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
	const cbtcCollateralAddress = getTargetAddress('CBTC', network);
	const sportsAMMV2LiquidityPoolAddress = getTargetAddress('SportsAMMV2LiquidityPoolCBTC', network);

	const defaultLiquidityProvider = await ethers.getContractFactory('DefaultLiquidityProvider');
	const defaultLiquidityProviderDeployed = await upgrades.deployProxy(
		defaultLiquidityProvider,
		[owner.address, sportsAMMV2LiquidityPoolAddress, cbtcCollateralAddress],
		{ initialOwner: protocolDAOAddress }
	);
	await defaultLiquidityProviderDeployed.waitForDeployment();

	const defaultLiquidityProviderAddress = await defaultLiquidityProviderDeployed.getAddress();

	console.log('DefaultLiquidityProvider deployed on:', defaultLiquidityProviderAddress);
	setTargetAddress('DefaultLiquidityProviderCBTC', network, defaultLiquidityProviderAddress);
	await delay(5000);

	const defaultLiquidityProviderImplementationAddress = await getImplementationAddress(
		ethers.provider,
		defaultLiquidityProviderAddress
	);
	console.log(
		'DefaultLiquidityProvider Implementation:',
		defaultLiquidityProviderImplementationAddress
	);
	setTargetAddress(
		'DefaultLiquidityProviderImplementationCBTC',
		network,
		defaultLiquidityProviderImplementationAddress
	);

	const defaultLiquidityProviderProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		defaultLiquidityProviderAddress
	);
	console.log('DefaultLiquidityProvider Proxy Admin:', defaultLiquidityProviderProxyAdminAddress);
	setTargetAddress(
		'DefaultLiquidityProviderProxyAdminCBTC',
		network,
		defaultLiquidityProviderProxyAdminAddress
	);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
		const sportsAMMV2LiquidityPoolDeployed = sportsAMMV2LiquidityPool.attach(
			sportsAMMV2LiquidityPoolAddress
		);
		await sportsAMMV2LiquidityPoolDeployed.setDefaultLiquidityProvider(
			defaultLiquidityProviderAddress,
			{
				from: owner.address,
			}
		);
		console.log('DefaultLiquidityProvider set in SportsAMMV2LiquidityPool');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: defaultLiquidityProviderAddress,
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
