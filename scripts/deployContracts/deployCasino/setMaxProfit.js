const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const newMax = ethers.parseEther('300');

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const c = await ethers.getContractAt(name, addr);
		const current = await c.maxProfitUsd();
		if (current !== newMax) {
			await c.setMaxProfitUsd(newMax);
			console.log(`${name}: maxProfitUsd set to $300`);
			await delay(3000);
		} else {
			console.log(`${name}: already $300`);
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
