const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const sportsAMMV2ResultManagerAddress = getTargetAddress('SportsAMMV2ResultManager', network);

	let defaultCap = '1000000000';
	let defaultRiskMultiplier = '5';
	let maxCap = '20000000000';
	let maxRiskMultiplier = '10';

	const minBuyInAmount = '3000000';
	const maxTicketSize = '15';
	const maxSupportedAmount = '20000000000';
	const maxSupportedOdds = '6666666666666666';

	const minimalTimeLeftToMaturity = '10';
	const expiryDuration = '7776000';

	const sportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManagerDeployed = await upgrades.deployProxy(
		sportsAMMV2RiskManager,
		[
			owner.address,
			sportsAMMV2ManagerAddress,
			sportsAMMV2ResultManagerAddress,
			defaultCap,
			defaultRiskMultiplier,
			maxCap,
			maxRiskMultiplier,
		],
		{ initialOwner: protocolDAOAddress }
	);
	await sportsAMMV2RiskManagerDeployed.waitForDeployment();

	const sportsAMMV2RiskManagerAddress = await sportsAMMV2RiskManagerDeployed.getAddress();

	console.log('SportsAMMV2RiskManager deployed on:', sportsAMMV2RiskManagerAddress);
	setTargetAddress('SportsAMMV2RiskManager', network, sportsAMMV2RiskManagerAddress);
	await delay(5000);

	await sportsAMMV2RiskManagerDeployed.setTicketParams(
		minBuyInAmount,
		maxTicketSize,
		maxSupportedAmount,
		maxSupportedOdds,
		{
			from: owner.address,
		}
	);
	console.log('Ticket params set in SportsAMMV2');

	await sportsAMMV2RiskManagerDeployed.setTimes(minimalTimeLeftToMaturity, expiryDuration, {
		from: owner.address,
	});
	console.log('Times set in SportsAMMV2');

	const sportsAMMV2RiskManagerImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2RiskManagerAddress
	);
	console.log(
		'SportsAMMV2RiskManager Implementation:',
		sportsAMMV2RiskManagerImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2RiskManagerImplementation',
		network,
		sportsAMMV2RiskManagerImplementationAddress
	);

	const sportsAMMV2RiskManagerProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		sportsAMMV2RiskManagerAddress
	);
	console.log('SportsAMMV2RiskManager Proxy Admin:', sportsAMMV2RiskManagerProxyAdminAddress);
	setTargetAddress(
		'SportsAMMV2RiskManagerProxyAdmin',
		network,
		sportsAMMV2RiskManagerProxyAdminAddress
	);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2RiskManagerAddress,
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
