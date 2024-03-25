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

	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);

	let sportsAMMV2ImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(sportsAMMV2Address, sportsAMMV2);

		sportsAMMV2ImplementationAddress = await getImplementationAddress(
			ethers.provider,
			sportsAMMV2Address
		);
	} else {
		sportsAMMV2ImplementationAddress = await upgrades.prepareUpgrade(
			sportsAMMV2Address,
			sportsAMMV2
		);
	}

	console.log('SportsAMMV2 upgraded');
	console.log('SportsAMMV2 Implementation:', sportsAMMV2ImplementationAddress);
	setTargetAddress('SportsAMMV2Implementation', network, sportsAMMV2ImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2ImplementationAddress,
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
