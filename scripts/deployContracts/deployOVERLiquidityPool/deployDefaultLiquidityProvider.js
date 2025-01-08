const { ethers } = require('hardhat');
const { getTargetAddress, setTargetAddress } = require('../../helpers');

async function main() {
	const networkName = hre.network.name;
	const [deployer] = await ethers.getSigners();

	console.log('Deploying DefaultLiquidityProvider for OVER with the account:', deployer.address);

	const DefaultLiquidityProvider = await ethers.getContractFactory('DefaultLiquidityProvider');

	const liquidityPool = await getTargetAddress('SportsAMMV2OVERLiquidityPool', networkName);
	const overToken = await getTargetAddress('OVER', networkName);

	const defaultLiquidityProvider = await DefaultLiquidityProvider.deploy(liquidityPool, overToken);

	await defaultLiquidityProvider.deployed();

	console.log('DefaultLiquidityProvider deployed to:', defaultLiquidityProvider.address);
	setTargetAddress(
		'SportsAMMV2OVERDefaultLiquidityProvider',
		networkName,
		defaultLiquidityProvider.address
	);

	try {
		await hre.run('verify:verify', {
			address: defaultLiquidityProvider.address,
			constructorArguments: [liquidityPool, overToken],
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
