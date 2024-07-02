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

	const sportsAMMV2LiquidityPoolData = await ethers.getContractFactory(
		'SportsAMMV2LiquidityPoolData'
	);
	const sportsAMMV2LiquidityPoolDataAddress = getTargetAddress(
		'SportsAMMV2LiquidityPoolData',
		network
	);

	let sportsAMMV2LiquidityPoolDataImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(sportsAMMV2LiquidityPoolDataAddress, sportsAMMV2LiquidityPoolData);

		sportsAMMV2LiquidityPoolDataImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2LiquidityPoolDataAddress
		);
	} else {
		sportsAMMV2LiquidityPoolDataImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2LiquidityPoolDataAddress,
			sportsAMMV2LiquidityPoolData
		);
	}

	console.log('SportsAMMV2LiquidityPoolData upgraded');
	console.log(
		'SportsAMMV2LiquidityPoolData Implementation:',
		sportsAMMV2LiquidityPoolDataImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolDataImplementation',
		network,
		sportsAMMV2LiquidityPoolDataImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2LiquidityPoolDataImplementationAddress,
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
