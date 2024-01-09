const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');

const { setTargetAddress, getTargetAddress } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	// if (networkObj.chainId == 420) {
	// 	networkObj.name = 'optimisticGoerli';
	// 	network = 'optimisticGoerli';
	// }

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const defaultCollateralAddress = getTargetAddress('DefaultCollateral', network);
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	const stakingThalesAddress = getTargetAddress('StakingThales', network);
	const safeBoxAddress = getTargetAddress('SafeBox', network);
	const maxAllowedDeposit = ethers.parseEther('20000');
	const maxAllowedDepositForUser = ethers.parseEther('20000');
	const minDepositAmount = ethers.parseEther('20');
	const maxAllowedUsers = 100;
	const week = 7 * 24 * 60 * 60;
	const utilizationRate = ethers.parseEther('0.2');
	const safeBoxImpact = ethers.parseEther('0.2');

	const sportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
	const sportsAMMV2LiquidityPoolDeployed = await upgrades.deployProxy(sportsAMMV2LiquidityPool, [
		{
			_owner: owner.address,
			_sportsAMM: sportsAMMV2Address,
			_stakingThales: stakingThalesAddress,
			_collateral: defaultCollateralAddress,
			_roundLength: week,
			_maxAllowedDeposit: maxAllowedDeposit,
			_maxAllowedDepositForUser: maxAllowedDepositForUser,
			_minDepositAmount: minDepositAmount,
			_maxAllowedUsers: maxAllowedUsers,
			_utilizationRate: utilizationRate,
			_safeBox: safeBoxAddress,
			_safeBoxImpact: safeBoxImpact,
		},
	]);
	await sportsAMMV2LiquidityPoolDeployed.waitForDeployment();

	const sportsAMMV2LiquidityPoolAddress = await sportsAMMV2LiquidityPoolDeployed.getAddress();

	console.log('SportsAMMV2LiquidityPool deployed on:', sportsAMMV2LiquidityPoolAddress);
	setTargetAddress('SportsAMMV2LiquidityPool', network, sportsAMMV2LiquidityPoolAddress);
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
		'SportsAMMV2LiquidityPoolImplementation',
		network,
		sportsAMMV2LiquidityPoolImplementationAddress
	);
	await delay(5000);

	if (networkObj.chainId == 420) {
		const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
		const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
		await sportsAMMV2Deployed.setLiquidityPool(sportsAMMV2LiquidityPoolAddress, {
			from: owner.address,
		});
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

function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time);
	});
}
