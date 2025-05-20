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
	const defaultCollateralAddress = getTargetAddress('DefaultCollateral', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const sportsAMMV2RiskManagerAddress = getTargetAddress('SportsAMMV2RiskManager', network);
	const sportsAMMV2ResultManagerAddress = getTargetAddress('SportsAMMV2ResultManager', network);
	const stakingThalesAddress = '0x0000000000000000000000000000000000000000';
	const referralsAddress = getTargetAddress('Referrals', network);
	const safeBoxAddress = getTargetAddress('SafeBox', network);

	const safeBoxFee = ethers.parseEther('0.02');

	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2Deployed = await upgrades.deployProxy(sportsAMMV2, [owner.address], {
		initialOwner: protocolDAOAddress,
	});
	await sportsAMMV2Deployed.waitForDeployment();

	const sportsAMMV2Address = await sportsAMMV2Deployed.getAddress();

	console.log('SportsAMMV2 deployed on:', sportsAMMV2Address);
	setTargetAddress('SportsAMMV2', network, sportsAMMV2Address);

	await delay(5000);

	await sportsAMMV2Deployed.setAddresses(
		defaultCollateralAddress,
		sportsAMMV2ManagerAddress,
		sportsAMMV2RiskManagerAddress,
		sportsAMMV2ResultManagerAddress,
		referralsAddress,
		stakingThalesAddress,
		safeBoxAddress,
		{
			from: owner.address,
		}
	);

	await delay(5000);

	await sportsAMMV2Deployed.setAmounts(safeBoxFee, {
		from: owner.address,
	});
	console.log('Amounts set in SportsAMMV2');

	const sportsAMMV2ImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2Address
	);
	console.log('SportsAMMV2 Implementation:', sportsAMMV2ImplementationAddress);
	setTargetAddress('SportsAMMV2Implementation', network, sportsAMMV2ImplementationAddress);

	const sportsAMMV2ProxyAdminAddress = await getAdminAddress(ethers.provider, sportsAMMV2Address);
	console.log('SportsAMMV2 Proxy Admin:', sportsAMMV2ProxyAdminAddress);
	setTargetAddress('SportsAMMV2ProxyAdmin', network, sportsAMMV2ProxyAdminAddress);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
		const sportsAMMV2RiskManagerDeployed = sportsAMMV2RiskManager.attach(
			sportsAMMV2RiskManagerAddress
		);
		await sportsAMMV2RiskManagerDeployed.setSportsAMM(sportsAMMV2Address, {
			from: owner.address,
		});
		console.log('SportsAMMV2 set in SportsAMMV2RiskManager');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2Address,
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
