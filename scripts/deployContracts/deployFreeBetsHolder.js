const { ethers } = require('hardhat');
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

	const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
	const freeBetsHolderDeployed = await upgrades.deployProxy(
		FreeBetsHolder,
		[protocolDAOAddress, sportsAMMV2Address, liveTradingProcessorAddress],
		{ initialOwner: protocolDAOAddress }
	);

	await freeBetsHolderDeployed.waitForDeployment();

	const freeBetsHolderAddress = await freeBetsHolderDeployed.getAddress();

	console.log('FreeBetsHolder deployed on:', freeBetsHolderAddress);
	setTargetAddress('FreeBetsHolder', network, freeBetsHolderAddress);
	await delay(5000);

	const freeBetsHolderImplementationAddress = await getImplementationAddress(
		ethers.provider,
		freeBetsHolderAddress
	);
	console.log('FreeBetsHolder Implementation:', freeBetsHolderImplementationAddress);
	setTargetAddress('FreeBetsHolderImplementation', network, freeBetsHolderImplementationAddress);

	const freeBetsHolderProxyAdminAddress = await getAdminAddress(
		ethers.provider,
		freeBetsHolderAddress
	);
	console.log('FreeBetsHolder Proxy Admin:', freeBetsHolderProxyAdminAddress);
	setTargetAddress('FreeBetsHolderProxyAdmin', network, freeBetsHolderProxyAdminAddress);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
		const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
		await sportsAMMV2Deployed.setFreeBetsHolder(freeBetsHolderAddress, {
			from: owner.address,
		});
		console.log('FreeBetsHolder set in SportsAMMV2');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: freeBetsHolderAddress,
			contract: 'contracts/core/FreeBets/FreeBetsHolder.sol:FreeBetsHolder',
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
