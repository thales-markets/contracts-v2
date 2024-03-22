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

	const sportsAMMV2Data = await ethers.getContractFactory('SportsAMMV2Data');
	const sportsAMMV2DataAddress = getTargetAddress('SportsAMMV2Data', network);

	let sportsAMMV2DataImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(sportsAMMV2DataAddress, sportsAMMV2Data);

		sportsAMMV2DataImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2DataAddress
		);
	} else {
		sportsAMMV2DataImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2DataAddress,
			sportsAMMV2Data
		);
	}

	console.log('SportsAMMV2Data upgraded');
	console.log('SportsAMMV2Data Implementation:', sportsAMMV2DataImplementationAddress);
	setTargetAddress('SportsAMMV2DataImplementation', network, sportsAMMV2DataImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2DataImplementationAddress,
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
