const { ethers } = require('hardhat');
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
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	const liveTradingProcessorAddress = getTargetAddress('LiveTradingProcessor', network);
	const thales = getTargetAddress('THALES', network);
	const stakingThales = getTargetAddress('StakingThales', network);

	const StakingThalesBettingProxy = await ethers.getContractFactory('StakingThalesBettingProxy');
	const stakingThalesBettingProxyDeployed = await upgrades.deployProxy(
		StakingThalesBettingProxy,
		[owner.address, sportsAMMV2Address, liveTradingProcessorAddress, stakingThales, thales],
		{ initialOwner: protocolDAOAddress }
	);

	await stakingThalesBettingProxyDeployed.waitForDeployment();

	const stakingThalesBettingProxyAddress = await stakingThalesBettingProxyDeployed.getAddress();

	console.log('StakingThalesBettingProxy deployed on:', stakingThalesBettingProxyAddress);
	setTargetAddress('StakingThalesBettingProxy', network, stakingThalesBettingProxyAddress);
	await delay(5000);

	const stakingThalesBettingProxyImplementationAddress = await getImplementationAddress(
		ethers.provider,
		stakingThalesBettingProxyAddress
	);
	console.log(
		'StakingThalesBettingProxy Implementation:',
		stakingThalesBettingProxyImplementationAddress
	);
	setTargetAddress(
		'StakingThalesBettingProxyImplementation',
		network,
		stakingThalesBettingProxyImplementationAddress
	);

	const stakingThalesBettingProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		stakingThalesBettingProxyAddress
	);
	console.log('StakingThalesBettingProxy Proxy Admin:', stakingThalesBettingProxyAdminAddress);
	setTargetAddress(
		'StakingThalesBettingProxyProxyAdmin',
		network,
		stakingThalesBettingProxyAdminAddress
	);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
		const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
		await sportsAMMV2Deployed.setStakingThalesBettingProxy(stakingThalesBettingProxyAddress, {
			from: owner.address,
		});
		console.log('StakingThalesBettingProxy set in SportsAMMV2');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: stakingThalesBettingProxyAddress,
			contract:
				'contracts/core/StakingThalesBetting/StakingThalesBettingProxy.sol:StakingThalesBettingProxy',
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
