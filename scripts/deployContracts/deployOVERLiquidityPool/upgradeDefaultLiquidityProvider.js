const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const networkName = hre.network.name;
	const [deployer] = await ethers.getSigners();

	console.log('Upgrading DefaultLiquidityProvider for OVER with the account:', deployer.address);

	const DefaultLiquidityProvider = await ethers.getContractFactory('DefaultLiquidityProvider');
	const proxyAddress = await getTargetAddress(
		'SportsAMMV2OVERDefaultLiquidityProvider',
		networkName
	);

	console.log('Proxy address:', proxyAddress);

	const implementation = await upgrades.prepareUpgrade(proxyAddress, DefaultLiquidityProvider);
	console.log('New DefaultLiquidityProvider implementation:', implementation);

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
