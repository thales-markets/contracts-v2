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

	const blackjack = await ethers.getContractFactory('Blackjack');
	const blackjackAddress = getTargetAddress('Blackjack', network);

	let blackjackImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(blackjackAddress, blackjack);

		blackjackImplementationAddress = await getImplementationAddress(
			ethers.provider,
			blackjackAddress
		);
	} else {
		blackjackImplementationAddress = await upgrades.prepareUpgrade(blackjackAddress, blackjack);
	}

	console.log('Blackjack upgraded');
	console.log('Blackjack Implementation:', blackjackImplementationAddress);
	setTargetAddress('BlackjackImplementation', network, blackjackImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: blackjackImplementationAddress,
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
