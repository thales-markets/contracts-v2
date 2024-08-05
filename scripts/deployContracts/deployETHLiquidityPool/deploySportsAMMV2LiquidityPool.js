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
	const wethCollateralAddress = getTargetAddress('WETH', network);
	const collateralKey = ethers.encodeBytes32String('ETH');
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	const addressManagerAddress = getTargetAddress('AddressManager', network);
	const safeBoxAddress = getTargetAddress('SafeBox', network);
	const maxAllowedDeposit = '50000000000000000000';
	const minDepositAmount = '100000000000000000';
	const maxAllowedUsers = 100;
	const week = 7 * 24 * 60 * 60;
	const utilizationRate = ethers.parseEther('0.5');
	const safeBoxImpact = ethers.parseEther('0.2');

	const sportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
	const sportsAMMV2LiquidityPoolDeployed = await upgrades.deployProxy(
		sportsAMMV2LiquidityPool,
		[
			{
				_owner: owner.address,
				_sportsAMM: sportsAMMV2Address,
				_addressManager: addressManagerAddress,
				_collateral: wethCollateralAddress,
				_collateralKey: collateralKey,
				_roundLength: week,
				_maxAllowedDeposit: maxAllowedDeposit,
				_minDepositAmount: minDepositAmount,
				_maxAllowedUsers: maxAllowedUsers,
				_utilizationRate: utilizationRate,
				_safeBox: safeBoxAddress,
				_safeBoxImpact: safeBoxImpact,
			},
		],
		{ initialOwner: protocolDAOAddress }
	);
	await sportsAMMV2LiquidityPoolDeployed.waitForDeployment();

	const sportsAMMV2LiquidityPoolAddress = await sportsAMMV2LiquidityPoolDeployed.getAddress();

	console.log('SportsAMMV2LiquidityPool deployed on:', sportsAMMV2LiquidityPoolAddress);
	setTargetAddress('SportsAMMV2LiquidityPoolWETH', network, sportsAMMV2LiquidityPoolAddress);
	await delay(5000);

	const sportsAMMV2LiquidityPoolImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2LiquidityPoolAddress
	);
	console.log(
		'SportsAMMV2LiquidityPool Implementation:',
		sportsAMMV2LiquidityPoolImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolImplementationWETH',
		network,
		sportsAMMV2LiquidityPoolImplementationAddress
	);

	const sportsAMMV2LiquidityPoolProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sportsAMMV2LiquidityPoolAddress
	);
	console.log('SportsAMMV2LiquidityPool Proxy Admin:', sportsAMMV2LiquidityPoolProxyAdminAddress);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolProxyAdminWETH',
		network,
		sportsAMMV2LiquidityPoolProxyAdminAddress
	);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
		const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
		await sportsAMMV2Deployed.setLiquidityPoolForCollateral(
			wethCollateralAddress,
			sportsAMMV2LiquidityPoolAddress,
			{
				from: owner.address,
			}
		);
		console.log('SportsAMMV2LiquidityPool set in SportsAMMV2');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2LiquidityPoolAddress,
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
