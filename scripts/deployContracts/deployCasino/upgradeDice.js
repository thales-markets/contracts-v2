const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const dice = await ethers.getContractFactory('Dice');
	const diceAddress = getTargetAddress('Dice', network);

	let diceImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(diceAddress, dice);

		diceImplementationAddress = await getImplementationAddress(ethers.provider, diceAddress);
	} else {
		diceImplementationAddress = await upgrades.prepareUpgrade(diceAddress, dice);
	}

	console.log('Dice upgraded');
	console.log('Dice Implementation:', diceImplementationAddress);
	setTargetAddress('DiceImplementation', network, diceImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: diceImplementationAddress,
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
