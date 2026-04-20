const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');
async function main() {
	const net = (await ethers.provider.getNetwork()).name;
	console.log(`\n${net}:`);
	for (const g of ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots']) {
		const addr = getTargetAddress(g, net);
		if (!addr) {
			console.log(`  ${g}: (not deployed)`);
			continue;
		}
		const c = await ethers.getContractAt(g, addr);
		const t = await c.cancelTimeout();
		console.log(`  ${g.padEnd(10)} cancelTimeout = ${t}s`);
	}
}
main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.then(() => process.exit(0));
