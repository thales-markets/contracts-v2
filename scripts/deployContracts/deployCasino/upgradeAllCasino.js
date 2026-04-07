const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

const GAMES = [
	{ name: 'Dice', implKey: 'DiceImplementation' },
	{ name: 'Roulette', implKey: 'RouletteImplementation' },
	{ name: 'Blackjack', implKey: 'BlackjackImplementation' },
	{ name: 'Baccarat', implKey: 'BaccaratImplementation' },
	{ name: 'Slots', implKey: 'SlotsImplementation' },
];

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	for (const game of GAMES) {
		const factory = await ethers.getContractFactory(game.name);
		const proxyAddress = getTargetAddress(game.name, network);

		let implAddress;
		if (isTestNetwork(networkObj.chainId)) {
			await upgrades.upgradeProxy(proxyAddress, factory);
			implAddress = await getImplementationAddress(ethers.provider, proxyAddress);
		} else {
			implAddress = await upgrades.prepareUpgrade(proxyAddress, factory);
		}

		console.log(`${game.name} upgraded. Implementation: ${implAddress}`);
		setTargetAddress(game.implKey, network, implAddress);
		await delay(5000);

		try {
			await hre.run('verify:verify', { address: implAddress });
		} catch (e) {
			console.log(`${game.name} verification:`, e.message?.slice(0, 100) || e);
		}
	}

	console.log('\nAll casino contracts upgraded.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
