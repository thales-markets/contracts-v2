/**
 * Sets maxProfitUsd to $300 on each V1 casino game.
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasino/setMaxProfitUsdV1.js \
 *     --network optimisticSepolia
 */

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const TARGET_USD = ethers.parseEther('300');

// Game name → (contract artifact name, setter style: 'maxProfit' = setMaxProfitUsd, 'risk' = setRiskParams)
const GAMES = [
	{ name: 'Dice', artifact: 'Dice', setter: 'maxProfit' },
	{ name: 'Slots', artifact: 'Slots', setter: 'maxProfit' },
	{ name: 'Roulette', artifact: 'Roulette', setter: 'maxProfit' },
	{ name: 'Baccarat', artifact: 'Baccarat', setter: 'maxProfit' },
	{ name: 'Blackjack', artifact: 'Blackjack', setter: 'risk' },
];

async function main() {
	const [signer] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Signer :', signer.address);
	console.log('Network:', network);
	console.log('Target :', ethers.formatEther(TARGET_USD), 'USD\n');

	for (const g of GAMES) {
		const addr = getTargetAddress(g.name, network);
		if (!addr) {
			console.log(`${g.name}: not in deployments.json — skipped`);
			continue;
		}
		const c = await ethers.getContractAt(g.artifact, addr);
		const before = await c.maxProfitUsd();
		if (before === TARGET_USD) {
			console.log(`${g.name} (${addr}): already $${ethers.formatEther(before)} — skipped`);
			continue;
		}
		const tx =
			g.setter === 'risk'
				? await c.setRiskParams(TARGET_USD, 0)
				: await c.setMaxProfitUsd(TARGET_USD);
		await tx.wait();
		const after = await c.maxProfitUsd();
		console.log(
			`${g.name} (${addr}): ${ethers.formatEther(before)} → ${ethers.formatEther(after)} USD  tx=${
				tx.hash
			}`
		);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
