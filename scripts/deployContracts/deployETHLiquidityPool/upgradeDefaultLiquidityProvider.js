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

	const defaultLiquidityProvider = await ethers.getContractFactory('DefaultLiquidityProvider');
	const defaultLiquidityProviderAddress = getTargetAddress('DefaultLiquidityProviderWETH', network);

	let defaultLiquidityProviderImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(defaultLiquidityProviderAddress, defaultLiquidityProvider);

		defaultLiquidityProviderImplementationAddress = await getImplementationAddress(
			ethers.provider,
			defaultLiquidityProviderAddress
		);
	} else {
		defaultLiquidityProviderImplementationAddress = await upgrades.prepareUpgrade(
			defaultLiquidityProviderAddress,
			defaultLiquidityProvider
		);
	}

	console.log('DefaultLiquidityProvider upgraded');
	console.log(
		'DefaultLiquidityProvider Implementation:',
		defaultLiquidityProviderImplementationAddress
	);
	setTargetAddress(
		'DefaultLiquidityProviderImplementationWETH',
		network,
		defaultLiquidityProviderImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: defaultLiquidityProviderImplementationAddress,
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
