// Live test targeting the exact path that previously failed at 500k callbackGasLimit:
// place → (if splittable) split → stand h1 → hit h2 → observe nested dealer-VRF path.
// We keep placing bets until we find a splittable pair, then force the scenario.

const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const Status = {
	NONE: 0n,
	AWAITING_DEAL: 1n,
	PLAYER_TURN: 2n,
	AWAITING_HIT: 3n,
	AWAITING_STAND: 4n,
	AWAITING_DOUBLE: 5n,
	RESOLVED: 6n,
	CANCELLED: 7n,
	AWAITING_SPLIT: 8n,
};
const StatusName = [
	'NONE',
	'AWAITING_DEAL',
	'PLAYER_TURN',
	'AWAITING_HIT',
	'AWAITING_STAND',
	'AWAITING_DOUBLE',
	'RESOLVED',
	'CANCELLED',
	'AWAITING_SPLIT',
];
const ResultName = [
	'NONE',
	'PLAYER_BLACKJACK',
	'PLAYER_WIN',
	'DEALER_WIN',
	'PUSH',
	'PLAYER_BUST',
	'DEALER_BUST',
];

const AMT = 3_000_000n;
const MAX_ROUNDS = 30;
const VRF_POLL_INTERVAL_MS = 5_000;
const VRF_TIMEOUT_MS = 420_000; // 7 min

function cardValue(rank) {
	if (rank === 1) return 11;
	if (rank >= 11) return 10;
	return rank;
}
function calcHandValue(cards) {
	let total = 0;
	let aces = 0;
	for (const r of cards) {
		total += cardValue(r);
		if (r === 1) aces++;
	}
	while (total > 21 && aces > 0) {
		total -= 10;
		aces--;
	}
	return total;
}

async function waitForStatusOut(bj, handId, fromStatus, label) {
	const t0 = Date.now();
	while (true) {
		const d = await bj.getHandDetails(handId);
		if (d.status !== fromStatus) {
			const dt = ((Date.now() - t0) / 1000).toFixed(1);
			console.log(`    ↳ ${label}: status ${fromStatus} → ${d.status} (${dt}s)`);
			return d;
		}
		if (Date.now() - t0 > VRF_TIMEOUT_MS) throw new Error(`Timeout: ${label}`);
		await new Promise((r) => setTimeout(r, VRF_POLL_INTERVAL_MS));
	}
}

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	if (network !== 'optimisticSepolia') throw new Error('safety stop');

	const bjAddr = getTargetAddress('Blackjack', network);
	const usdcAddr = getTargetAddress('DefaultCollateral', network);
	const bj = await ethers.getContractAt('Blackjack', bjAddr);
	const usdc = await ethers.getContractAt('IERC20', usdcAddr);

	console.log(`Blackjack: ${bjAddr}`);
	console.log(`Signer:    ${signer.address}`);
	const cbGas = await bj.callbackGasLimit();
	console.log(`callbackGasLimit: ${cbGas}\n`);

	let success = false;

	for (let round = 1; round <= MAX_ROUNDS && !success; round++) {
		console.log(`\n=== Round ${round}/${MAX_ROUNDS} ===`);
		await (await usdc.approve(bjAddr, AMT)).wait();
		const betTx = await bj.placeBet(usdcAddr, AMT, ethers.ZeroAddress);
		const betRc = await betTx.wait();
		const created = betRc.logs
			.map((l) => {
				try {
					return bj.interface.parseLog(l);
				} catch {
					return null;
				}
			})
			.find((e) => e?.name === 'HandCreated');
		const handId = created.args.handId;
		console.log(`  handId ${handId}, placeBet gas ${betRc.gasUsed}`);

		const afterDeal = await waitForStatusOut(bj, handId, Status.AWAITING_DEAL, 'deal');
		if (afterDeal.status === Status.RESOLVED) {
			console.log(`  natural BJ → ${ResultName[Number(afterDeal.result)]}, skip`);
			continue;
		}

		const c = await bj.getHandCards(handId);
		const player = c.playerCards.map((x) => Number(x));
		const dealer = Number(c.dealerCards[0]);
		console.log(`  cards: player ${JSON.stringify(player)} dealer ${dealer}`);

		const splittable = cardValue(player[0]) === cardValue(player[1]);
		if (!splittable) {
			console.log(`  not splittable — standing to lose/push and retry`);
			await (await bj.stand(handId)).wait();
			await waitForStatusOut(bj, handId, Status.AWAITING_STAND, 'stand-resolve');
			continue;
		}

		console.log(`  ✓ splittable pair (value ${cardValue(player[0])}) — splitting`);
		await (await usdc.approve(bjAddr, AMT)).wait();
		const splitTx = await bj.split(handId);
		const splitRc = await splitTx.wait();
		console.log(`    split gas ${splitRc.gasUsed}`);
		await waitForStatusOut(bj, handId, Status.AWAITING_SPLIT, 'split-deal');

		// Stand hand 1 (synchronous advance)
		await (await bj.stand(handId)).wait();
		let ss = await bj.getSplitDetails(handId);
		console.log(`    stand(h1): activeHand=${ss.activeHand}`);

		// Hit hand 2 until it busts OR lands on 21 (triggers nested dealer VRF request)
		for (let step = 0; step < 8; step++) {
			const cc = await bj.getHandCards(handId);
			ss = await bj.getSplitDetails(handId);
			const h2 = ss.player2Cards.map((x) => Number(x)).slice(0, Number(ss.player2CardCount));
			const h2Val = calcHandValue(h2);
			console.log(`    hand2 ${JSON.stringify(h2)} = ${h2Val}`);
			if (h2Val >= 21) break;

			console.log(`    hitting hand 2 (val ${h2Val})...`);
			const hitTx = await bj.hit(handId);
			const hitRc = await hitTx.wait();
			console.log(`      hit gas ${hitRc.gasUsed}`);
			const dAfter = await waitForStatusOut(bj, handId, Status.AWAITING_HIT, 'hit-fulfill');

			if (dAfter.status === Status.AWAITING_STAND) {
				console.log(`    ★ AWAITING_STAND — nested dealer VRF request fired in callback!`);
				console.log(`      Waiting for dealer VRF to fulfill under 1M callback gas...`);
				const finalD = await waitForStatusOut(bj, handId, Status.AWAITING_STAND, 'dealer-resolve');
				const finalCards = await bj.getHandCards(handId);
				const finalSS = await bj.getSplitDetails(handId);
				const finalBase = await bj.getHandBase(handId);
				console.log(`\n    === FINAL RESULT ===`);
				console.log(
					`      dealer cards: ${JSON.stringify(finalCards.dealer.map((x) => Number(x)))}`
				);
				console.log(
					`      hand1 = ${JSON.stringify(finalCards.player.map((x) => Number(x)))} → ${
						ResultName[Number(finalD.result)]
					}`
				);
				console.log(
					`      hand2 = ${JSON.stringify(
						finalSS.player2Cards.map((x) => Number(x)).slice(0, Number(finalSS.player2CardCount))
					)} → ${ResultName[Number(finalSS.result2)]}`
				);
				console.log(`      total payout = ${ethers.formatUnits(finalBase.payout, 6)} USDC`);
				console.log(`\n✓ Nested-VRF path SUCCEEDED under 1M callback gas. Test complete.`);
				success = true;
				break;
			} else if (dAfter.status === Status.RESOLVED) {
				// Both hands busted → direct resolve in callback (no dealer VRF)
				console.log(`    both hands busted — resolved directly (no dealer VRF)`);
				const finalBase = await bj.getHandBase(handId);
				console.log(`    payout = ${ethers.formatUnits(finalBase.payout, 6)}`);
				break; // retry on a new round
			}
			// else: status = PLAYER_TURN, continue loop (hand 2 didn't bust yet)
		}

		// If we didn't hit the scenario, make sure the hand is resolved before next round
		const midD = await bj.getHandDetails(handId);
		if (midD.status === Status.PLAYER_TURN) {
			console.log(`  didn't trigger — standing hand 2 to close out`);
			await (await bj.stand(handId)).wait();
			await waitForStatusOut(bj, handId, Status.AWAITING_STAND, 'final-resolve');
		}
	}

	if (!success) {
		console.log(`\n✗ Did not trigger nested-VRF scenario in ${MAX_ROUNDS} rounds.`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
