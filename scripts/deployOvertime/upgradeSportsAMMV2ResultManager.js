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

	const sportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManagerAddress = getTargetAddress('SportsAMMV2ResultManager', network);

	let sportsAMMV2ResultManagerImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(sportsAMMV2ResultManagerAddress, sportsAMMV2ResultManager);

		sportsAMMV2ResultManagerImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2ResultManagerAddress
		);
	} else {
		sportsAMMV2ResultManagerImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2ResultManagerAddress,
			sportsAMMV2ResultManager
		);
	}

	console.log('SportsAMMV2ResultManager upgraded');
	console.log(
		'SportsAMMV2ResultManager Implementation:',
		sportsAMMV2ResultManagerImplementationAddress
	);
	setTargetAddress(
		'SportsAMMV2ResultManagerImplementation',
		network,
		sportsAMMV2ResultManagerImplementationAddress
	);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2ResultManagerImplementationAddress,
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
