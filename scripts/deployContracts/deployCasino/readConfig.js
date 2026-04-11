const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	const network = (await ethers.provider.getNetwork()).name;

	const games = [
		{ name: 'Dice', contract: 'Dice' },
		{ name: 'Roulette', contract: 'Roulette' },
		{ name: 'Blackjack', contract: 'Blackjack' },
		{ name: 'Baccarat', contract: 'Baccarat' },
		{ name: 'Slots', contract: 'Slots' },
	];

	for (const g of games) {
		const addr = getTargetAddress(g.name, network);
		const c = await ethers.getContractAt(g.contract, addr);

		console.log(`\n=== ${g.name} (${addr}) ===`);
		console.log('  maxProfitUsd:', ethers.formatEther(await c.maxProfitUsd()));
		console.log('  cancelTimeout:', (await c.cancelTimeout()).toString() + 's');

		if (g.name === 'Dice' || g.name === 'Slots') {
			console.log('  houseEdge:', ethers.formatEther(await c.houseEdge()));
		}
		if (g.name === 'Slots') {
			console.log('  maxPayoutMultiplier:', ethers.formatEther(await c.maxPayoutMultiplier()));
			const symbolCount = Number(await c.symbolCount());
			console.log('  symbolCount:', symbolCount);
			for (let i = 0; i < symbolCount; i++) {
				const weight = await c.symbolWeights(i);
				const pair = await c.pairPayout(i);
				const triple = await c.triplePayout(i);
				console.log(
					`  symbol[${i}]: weight=${weight.toString()}, ` +
						`pair=${ethers.formatEther(pair)}x, triple=${ethers.formatEther(triple)}x`
				);
			}
		}
		if (g.name === 'Baccarat') {
			console.log(
				'  bankerPayoutMultiplier:',
				ethers.formatEther(await c.bankerPayoutMultiplier())
			);
		}

		console.log('  freeBetsHolder:', await c.freeBetsHolder());
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
