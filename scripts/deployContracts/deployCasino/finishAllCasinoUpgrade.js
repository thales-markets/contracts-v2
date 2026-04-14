const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

const GAMES = [
	{ name: 'Dice', implKey: 'DiceImplementation' },
	{ name: 'Roulette', implKey: 'RouletteImplementation' },
	{ name: 'Blackjack', implKey: 'BlackjackImplementation' },
	{ name: 'Baccarat', implKey: 'BaccaratImplementation' },
	{ name: 'Slots', implKey: 'SlotsImplementation' },
];

async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner:', owner.address);
	console.log('Network:', network);

	for (const game of GAMES) {
		const proxyAddress = getTargetAddress(game.name, network);
		const factory = await ethers.getContractFactory(game.name);

		const implBefore = await getImplementationAddress(ethers.provider, proxyAddress);
		console.log(`\n${game.name} proxy: ${proxyAddress}\n  impl before: ${implBefore}`);

		await upgrades.upgradeProxy(proxyAddress, factory);

		const implAfter = await getImplementationAddress(ethers.provider, proxyAddress);
		console.log(`  impl after:  ${implAfter}`);

		setTargetAddress(game.implKey, network, implAfter);
		await delay(5000);

		try {
			await hre.run('verify:verify', { address: implAfter });
		} catch (e) {
			console.log(`  verify: ${e.message?.slice(0, 120) || e}`);
		}
		await delay(3000);
	}

	console.log('\nAll casino proxies upgraded.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
