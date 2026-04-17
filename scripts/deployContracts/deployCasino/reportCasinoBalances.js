const { ethers } = require('hardhat');
const all = require('../../deployments.json');

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	if (!addrs) throw new Error(`No deployments for ${network}`);

	console.log(`\n=== ${network} (chain ${networkObj.chainId}) ===`);

	const usdc = await ethers.getContractAt('IERC20', addrs.DefaultCollateral);
	const decimals = 6;

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	console.log(`USDC: ${addrs.DefaultCollateral}\n`);
	for (const g of games) {
		const a = addrs[g];
		if (!a) {
			console.log(`${g.padEnd(10)} (not deployed)`);
			continue;
		}
		const bal = await usdc.balanceOf(a);
		const human = Number(bal) / 10 ** decimals;
		console.log(`${g.padEnd(10)} ${a}  USDC=${human.toFixed(2)}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
