const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');

const { setTargetAddress, getTargetAddress, isTestNetwork } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);

	let sportsAMMV2ManagerImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(sportsAMMV2ManagerAddress, sportsAMMV2Manager);

		sportsAMMV2ManagerImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2ManagerAddress
		);
	} else {
		sportsAMMV2ManagerImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2ManagerAddress,
			sportsAMMV2Manager
		);
	}

	console.log('SportsAMMV2Manager upgraded');
	console.log('SportsAMMV2Manager Implementation:', sportsAMMV2ManagerImplementationAddress);
	setTargetAddress(
		'SportsAMMV2ManagerImplementation',
		network,
		sportsAMMV2ManagerImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2ManagerImplementationAddress,
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
