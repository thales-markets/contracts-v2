const { ethers } = require('hardhat');
const { getTargetAddress, setTargetAddress } = require('../../helpers');

async function main() {
	const networkName = hre.network.name;
	const [deployer] = await ethers.getSigners();

	console.log('Deploying SportsAMMV2LiquidityPool for OVER with the account:', deployer.address);

	const SportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');

	const overToken = await getTargetAddress('OVER', networkName);
	const liquidityPoolData = await getTargetAddress('SportsAMMV2LiquidityPoolData', networkName);
	const roundMastercopy = await getTargetAddress(
		'SportsAMMV2LiquidityPoolRoundMastercopy',
		networkName
	);

	const liquidityPool = await SportsAMMV2LiquidityPool.deploy(
		overToken,
		liquidityPoolData,
		roundMastercopy
	);

	await liquidityPool.deployed();

	console.log('SportsAMMV2LiquidityPool deployed to:', liquidityPool.address);
	setTargetAddress('SportsAMMV2OVERLiquidityPool', networkName, liquidityPool.address);

	try {
		await hre.run('verify:verify', {
			address: liquidityPool.address,
			constructorArguments: [overToken, liquidityPoolData, roundMastercopy],
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
