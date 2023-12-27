const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');

const { setTargetAddress, getTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	// if (networkObj.chainId == 420) {
	// 	networkObj.name = 'optimisticGoerli';
	// 	network = 'optimisticGoerli';
	// }

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManagerAddress = getTargetAddress('SportsAMMV2RiskManager', network);

	let sportsAMMV2RiskManagerImplementationAddress;
	if (networkObj.chainId == 10) {
		sportsAMMV2RiskManagerImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2RiskManagerAddress,
			sportsAMMV2RiskManager
		);
	}

	// upgrade if test networks
	if (networkObj.chainId == 420) {
		await upgrades.upgradeProxy(sportsAMMV2RiskManagerAddress, sportsAMMV2RiskManager);

		sportsAMMV2RiskManagerImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2RiskManagerAddress
		);
	}

	console.log('SportsAMMV2RiskManager upgraded');
	console.log(
		'SportsAMMV2RiskManager Implementation:',
		sportsAMMV2RiskManagerImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2RiskManagerImplementation',
		network,
		sportsAMMV2RiskManagerImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2RiskManagerImplementationAddress,
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

function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time);
	});
}
