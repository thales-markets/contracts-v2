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

	const roulette = await ethers.getContractFactory('Roulette');
	const rouletteAddress = getTargetAddress('Roulette', network);

	let rouletteImplementationAddress;

	// upgrade if test networks
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(rouletteAddress, roulette);

		rouletteImplementationAddress = await getImplementationAddress(
			ethers.provider,
			rouletteAddress
		);
	} else {
		rouletteImplementationAddress = await upgrades.prepareUpgrade(rouletteAddress, roulette);
	}

	console.log('Roulette upgraded');
	console.log('Roulette Implementation:', rouletteImplementationAddress);
	setTargetAddress('RouletteImplementation', network, rouletteImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: rouletteImplementationAddress,
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
