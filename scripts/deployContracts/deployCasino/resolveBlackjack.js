const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const network = (await ethers.provider.getNetwork()).name;
	const blackjack = await ethers.getContractAt('Blackjack', getTargetAddress('Blackjack', network));

	const totalHands = Number(await blackjack.nextHandId()) - 1;

	for (let i = 1; i <= totalHands; i++) {
		const d = await blackjack.getHandDetails(i);
		const statusNum = Number(d.status);

		if (statusNum === 1) {
			// AWAITING_DEAL — VRF hasn't responded yet, wait
			console.log(`Hand #${i}: AWAITING_DEAL — waiting 15s...`);
			await delay(15000);
			const d2 = await blackjack.getHandDetails(i);
			if (Number(d2.status) === 1) {
				console.log(`  Still awaiting deal. Skipping.`);
				continue;
			}
		}

		const d2 = await blackjack.getHandDetails(i);
		if (Number(d2.status) === 2) {
			// PLAYER_TURN — stand
			const cards = await blackjack.getHandCards(i);
			console.log(
				`Hand #${i}: PLAYER_TURN, player has ${cards.playerCards.length} cards, dealer shows ${cards.dealerCards.length}. Standing...`
			);
			await blackjack.stand(i);
			console.log(`  Stand requested. Waiting 15s for VRF...`);
			await delay(15000);

			const d3 = await blackjack.getHandDetails(i);
			const b3 = await blackjack.getHandBase(i);
			const statusStr = Number(d3.status) === 6 ? 'RESOLVED' : `STATUS(${d3.status})`;
			console.log(
				`  ${statusStr}, result=${d3.result}, payout=${ethers.formatUnits(b3.payout, 6)}`
			);
		} else if (Number(d2.status) === 6) {
			const b = await blackjack.getHandBase(i);
			console.log(
				`Hand #${i}: already RESOLVED, result=${d2.result}, payout=${ethers.formatUnits(
					b.payout,
					6
				)}`
			);
		} else {
			console.log(`Hand #${i}: status=${d2.status}`);
		}
	}

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
