const { ethers } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { getTargetAddress } = require('../../helpers');

const GAMES = [
	{ name: 'Dice', implKey: 'DiceImplementation' },
	{ name: 'Roulette', implKey: 'RouletteImplementation' },
	{ name: 'Blackjack', implKey: 'BlackjackImplementation' },
	{ name: 'Baccarat', implKey: 'BaccaratImplementation' },
	{ name: 'Slots', implKey: 'SlotsImplementation' },
];

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	console.log('Network:', network, 'ChainId:', Number(networkObj.chainId));

	for (const game of GAMES) {
		const proxyAddress = getTargetAddress(game.name, network);
		if (!proxyAddress) {
			console.log(`${game.name}: not deployed on ${network}`);
			continue;
		}
		const onchainImpl = await getImplementationAddress(ethers.provider, proxyAddress);
		const recordedImpl = getTargetAddress(game.implKey, network);
		const match = onchainImpl.toLowerCase() === (recordedImpl || '').toLowerCase();
		console.log(
			`${game.name}:\n  proxy:      ${proxyAddress}\n  on-chain:   ${onchainImpl}\n  recorded:   ${recordedImpl}\n  match:      ${match}`
		);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
