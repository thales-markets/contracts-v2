const { ethers } = require('hardhat');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2DataAddress = getTargetAddress('SportsAMMV2Data', network);

	if (!sportsAMMV2DataAddress) {
		throw new Error(`SportsAMMV2Data not found for network ${network}`);
	}

	console.log('SportsAMMV2Data:', sportsAMMV2DataAddress);

	// deploy utils
	const SportsAMMV2DataUtils = await ethers.getContractFactory('SportsAMMV2DataUtils');
	const sportsAMMV2DataUtilsDeployed = await SportsAMMV2DataUtils.deploy();
	await sportsAMMV2DataUtilsDeployed.waitForDeployment();

	const sportsAMMV2DataUtilsAddress = await sportsAMMV2DataUtilsDeployed.getAddress();

	console.log('SportsAMMV2DataUtils deployed on:', sportsAMMV2DataUtilsAddress);
	setTargetAddress('SportsAMMV2DataUtils', network, sportsAMMV2DataUtilsAddress);

	await delay(5000);

	// only set on testnets
	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2Data = await ethers.getContractFactory('SportsAMMV2Data');
		const sportsAMMV2DataDeployed = sportsAMMV2Data.attach(sportsAMMV2DataAddress);

		await sportsAMMV2DataDeployed.setDataUtils(sportsAMMV2DataUtilsAddress, {
			from: owner.address,
		});
		console.log('SportsAMMV2DataUtils set in SportsAMMV2Data');
	} else {
		console.log(
			'Skipping setDataUtils on non-testnet. This should be executed externally by the multisig/owner.'
		);
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2DataUtilsAddress,
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
