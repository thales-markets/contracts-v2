const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const networkName = hre.network.name;
	const [deployer] = await ethers.getSigners();

	console.log('Upgrading SportsAMMV2LiquidityPool for OVER with the account:', deployer.address);

	const SportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
	const proxyAddress = await getTargetAddress('SportsAMMV2OVERLiquidityPool', networkName);

	console.log('Proxy address:', proxyAddress);

	const implementation = await upgrades.prepareUpgrade(proxyAddress, SportsAMMV2LiquidityPool);
	console.log('New SportsAMMV2LiquidityPool implementation:', implementation);

	try {
		await hre.run('verify:verify', {
			address: implementation,
			constructorArguments: [],
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
