const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const defaultCollateralAddress = '0x4200000000000000000000000000000000000042';

	// Merkle root generated from sample CSV data
	const merkleRoot = '0x2770653d666a5a5269c86e55a1a0137280b49972471f321d6ec71b2d5a29d915';

	console.log('Using merkle root:', merkleRoot);
	console.log('Using collateral address:', defaultCollateralAddress);

	const overdropRewards = await ethers.getContractFactory('OverdropRewards');
	const overdropRewardsDeployed = await upgrades.deployProxy(
		overdropRewards,
		[owner.address, defaultCollateralAddress, merkleRoot],
		{
			initialOwner: protocolDAOAddress,
		}
	);
	await overdropRewardsDeployed.waitForDeployment();

	const overdropRewardsAddress = await overdropRewardsDeployed.getAddress();

	console.log('OverdropRewards deployed on:', overdropRewardsAddress);
	setTargetAddress('OverdropRewards', network, overdropRewardsAddress);

	await delay(5000);

	// Enable claims by default
	await overdropRewardsDeployed.setClaimsEnabled(true, {
		from: owner.address,
	});
	console.log('Claims enabled in OverdropRewards');

	const overdropRewardsImplementationAddress = await getImplementationAddress(
		ethers.provider,
		overdropRewardsAddress
	);
	console.log('OverdropRewards Implementation:', overdropRewardsImplementationAddress);
	setTargetAddress('OverdropRewardsImplementation', network, overdropRewardsImplementationAddress);

	const overdropRewardsProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		overdropRewardsAddress
	);
	console.log('OverdropRewards Proxy Admin:', overdropRewardsProxyAdminAddress);
	setTargetAddress('OverdropRewardsProxyAdmin', network, overdropRewardsProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: overdropRewardsAddress,
		});
	} catch (e) {
		console.log(e);
	}

	console.log('\n=== Deployment Summary ===');
	console.log('OverdropRewards Contract:', overdropRewardsAddress);
	console.log('Merkle Root:', merkleRoot);
	console.log('Collateral Token:', defaultCollateralAddress);
	console.log('Owner:', owner.address);
	console.log('Protocol DAO (Proxy Owner):', protocolDAOAddress);
	console.log('Claims Enabled: true');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
