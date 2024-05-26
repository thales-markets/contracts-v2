const { ethers } = require('hardhat');

const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2LiquidityPoolRoundMastercopy = await ethers.getContractFactory(
		'SportsAMMV2LiquidityPoolRoundMastercopy'
	);

	const sportsAMMV2LiquidityPoolRoundMastercopyDeployed =
		await sportsAMMV2LiquidityPoolRoundMastercopy.deploy();
	await sportsAMMV2LiquidityPoolRoundMastercopyDeployed.waitForDeployment();

	const sportsAMMV2LiquidityPoolRoundMastercopyAddress =
		await sportsAMMV2LiquidityPoolRoundMastercopyDeployed.getAddress();

	console.log(
		'SportsAMMV2LiquidityPoolRoundMastercopy deployed on:',
		sportsAMMV2LiquidityPoolRoundMastercopyAddress
	);
	setTargetAddress(
		'SportsAMMV2LiquidityPoolRoundMastercopy',
		network,
		sportsAMMV2LiquidityPoolRoundMastercopyAddress
	);
	await delay(5000);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
		const sportsAMMV2LiquidityPoolAddress = getTargetAddress('SportsAMMV2LiquidityPool', network);
		const sportsAMMV2LiquidityPoolDeployed = sportsAMMV2LiquidityPool.attach(
			sportsAMMV2LiquidityPoolAddress
		);

		await sportsAMMV2LiquidityPoolDeployed.setPoolRoundMastercopy(
			sportsAMMV2LiquidityPoolRoundMastercopyAddress,
			{
				from: owner.address,
			}
		);
		console.log('SportsAMMV2LiquidityPoolRoundMastercopy set in SportsAMMV2LiquidityPool');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2LiquidityPoolRoundMastercopyAddress,
			contract:
				'contracts/core/LiquidityPool/SportsAMMV2LiquidityPoolRoundMastercopy.sol:SportsAMMV2LiquidityPoolRoundMastercopy',
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
