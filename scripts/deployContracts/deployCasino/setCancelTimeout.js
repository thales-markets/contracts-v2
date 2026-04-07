const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const timeout = 60;

	const games = ['Roulette', 'Blackjack', 'Dice', 'Baccarat', 'Slots'];

	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);
		const current = await contract.cancelTimeout();
		console.log(`${name} (${addr}) cancelTimeout: ${current} -> ${timeout}`);

		if (Number(current) !== timeout) {
			const tx = await contract.setCancelTimeout(timeout);
			await tx.wait();
			console.log(`  Updated. tx: ${tx.hash}`);
			await delay(3000);
		} else {
			console.log('  Already set');
		}
	}

	console.log('\nDone');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
