const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
	const sportsAMMV2LiquidityPoolAddress = getTargetAddress('SportsAMMV2LiquidityPoolWETH', network);

	let sportsAMMV2LiquidityPoolImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(sportsAMMV2LiquidityPoolAddress, sportsAMMV2LiquidityPool);

		sportsAMMV2LiquidityPoolImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2LiquidityPoolAddress
		);
	} else {
		sportsAMMV2LiquidityPoolImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2LiquidityPoolAddress,
			sportsAMMV2LiquidityPool
		);
	}

	console.log('SportsAMMV2LiquidityPool upgraded');
	console.log(
		'SportsAMMV2LiquidityPool Implementation:',
		sportsAMMV2LiquidityPoolImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolImplementationWETH',
		network,
		sportsAMMV2LiquidityPoolImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2LiquidityPoolImplementationAddress,
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
