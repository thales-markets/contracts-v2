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
const ResultName = [
	'NONE',
	'PLAYER_BLACKJACK',
	'PLAYER_WIN',
	'DEALER_WIN',
	'PUSH',
	'PLAYER_BUST',
	'DEALER_BUST',
];
const AMT = 3_000_000n; // 3 USDC
const MAX_ATTEMPTS_PAIR = 25;
const VRF_POLL_INTERVAL_MS = 5_000;
const VRF_TIMEOUT_MS = 180_000; // 3 minutes

function cardValue(rank) {
	if (rank === 1) return 11;
	if (rank >= 11) return 10;
	return rank;
}

async function waitForStatusChange(blackjack, handId, fromStatus, label) {
	const t0 = Date.now();
	while (true) {
		const d = await blackjack.getHandDetails(handId);
		if (d.status !== fromStatus) {
			const dt = ((Date.now() - t0) / 1000).toFixed(1);
			console.log(`    ↳ ${label}: status ${fromStatus} → ${d.status} (${dt}s)`);
			return d;
		}
		if (Date.now() - t0 > VRF_TIMEOUT_MS) {
			throw new Error(`Timeout waiting for ${label} (handId=${handId})`);
		}
		await new Promise((r) => setTimeout(r, VRF_POLL_INTERVAL_MS));
	}
}

async function logGas(tx, label) {
	const rc = await tx.wait();
	console.log(`    gas ${label.padEnd(16)} = ${rc.gasUsed.toString()}  tx ${rc.hash}`);
	return rc;
}

async function getCards(blackjack, handId) {
	const c = await blackjack.getHandCards(handId);
	return {
		player: c.playerCards.map((x) => Number(x)),
		dealer: c.dealerCards.map((x) => Number(x)),
	};
}

async function main() {
	const [signer] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	if (network !== 'optimisticSepolia') {
		throw new Error(`Expected optimisticSepolia, got ${network}. Safety stop.`);
	}

	const bjAddr = getTargetAddress('Blackjack', network);
	const usdcAddr = getTargetAddress('DefaultCollateral', network);
	console.log(`Network:    ${network}`);
	console.log(`Signer:     ${signer.address}`);
	console.log(`Blackjack:  ${bjAddr}`);
	console.log(`USDC:       ${usdcAddr}\n`);

	const blackjack = await ethers.getContractAt('Blackjack', bjAddr);
	const usdc = await ethers.getContractAt('IERC20', usdcAddr);

	const sigBal = await usdc.balanceOf(signer.address);
	const bankBal = await usdc.balanceOf(bjAddr);
	const reserved = await blackjack.reservedProfitPerCollateral(usdcAddr);
	console.log(`Signer USDC:     ${ethers.formatUnits(sigBal, 6)}`);
	console.log(`Bankroll USDC:   ${ethers.formatUnits(bankBal, 6)}`);
	console.log(`Reserved profit: ${ethers.formatUnits(reserved, 6)}`);
	console.log(
		`Available:       ${ethers.formatUnits(bankBal > reserved ? bankBal - reserved : 0n, 6)}\n`
	);

	if (sigBal < AMT * 30n) {
		console.log(
			`⚠ Signer needs at least ${ethers.formatUnits(
				AMT * 30n,
				6
			)} USDC for a full run (bet retries + split stakes + doubles).`
		);
	}

	/* =================== Phase 1: find any value-matched pair =================== */

	console.log(
		`=== Phase 1: placing bets until we find a splittable pair (max ${MAX_ATTEMPTS_PAIR}) ===`
	);
	let pairHandId = null;
	let pairCards = null;

	for (let i = 1; i <= MAX_ATTEMPTS_PAIR; i++) {
		console.log(`\nAttempt ${i}:`);

		await logGas(await usdc.approve(bjAddr, AMT), 'approve');
		const betTx = await blackjack.placeBet(usdcAddr, AMT, ethers.ZeroAddress);
		const betRc = await logGas(betTx, 'placeBet');

		const handCreatedTopic = blackjack.interface.getEvent('HandCreated').topicHash;
		const log = betRc.logs.find((l) => l.topics[0] === handCreatedTopic);
		const parsed = blackjack.interface.parseLog(log);
		const handId = parsed.args.handId;
		console.log(`    handId = ${handId}`);

		const d = await waitForStatusChange(blackjack, handId, Status.AWAITING_DEAL, 'deal');
		const cards = await getCards(blackjack, handId);
		console.log(
			`    cards: player ${JSON.stringify(cards.player)} dealer face-up ${cards.dealer[0]}`
		);

		// Check matched-value pair. Must also be at PLAYER_TURN (i.e., no immediate BJ auto-resolve)
		if (
			d.status === Status.PLAYER_TURN &&
			cards.player.length === 2 &&
			cardValue(cards.player[0]) === cardValue(cards.player[1])
		) {
			console.log(`    ✓ matched pair! Value ${cardValue(cards.player[0])}`);
			pairHandId = handId;
			pairCards = cards;
			break;
		}

		// Otherwise, finish the hand cheaply: stand if still player turn; wait for resolution
		if (d.status === Status.PLAYER_TURN) {
			const standTx = await blackjack.stand(handId);
			await logGas(standTx, 'stand(loser)');
			await waitForStatusChange(blackjack, handId, Status.AWAITING_STAND, 'stand-resolve');
		}
		const finalD = await blackjack.getHandDetails(handId);
		console.log(`    resolved: ${ResultName[Number(finalD.result)]}`);
	}

	if (!pairHandId) {
		console.log(`\n✗ No pair found in ${MAX_ATTEMPTS_PAIR} attempts — stopping.`);
		return;
	}

	/* =================== Phase 2: execute split on the matched pair =================== */

	console.log(`\n=== Phase 2: split on handId ${pairHandId} ===`);

	const aceSplit = cardValue(pairCards.player[0]) === 11;
	console.log(`  isAceSplit = ${aceSplit}`);

	await logGas(await usdc.approve(bjAddr, AMT), 'approve');
	const splitRc = await logGas(await blackjack.split(pairHandId), 'split');

	// Post-split fulfillment
	if (aceSplit) {
		// ace split auto-resolves in one callback
		const finalD = await waitForStatusChange(
			blackjack,
			pairHandId,
			Status.AWAITING_SPLIT,
			'ace-split-resolve'
		);
		const cards = await getCards(blackjack, pairHandId);
		const ss = await blackjack.getSplitDetails(pairHandId);
		const base = await blackjack.getHandBase(pairHandId);
		console.log(
			`    hand1 cards=${JSON.stringify(cards.player)} result=${ResultName[Number(finalD.result)]}`
		);
		console.log(
			`    hand2 cards=${JSON.stringify(ss.player2Cards.map((x) => Number(x)))} result=${
				ResultName[Number(ss.result2)]
			}`
		);
		console.log(`    dealer cards=${JSON.stringify(cards.dealer)}`);
		console.log(`    total payout: ${ethers.formatUnits(base.payout, 6)} USDC`);
		console.log(`\n=== Live test complete (ace-split path) ===`);
		return;
	}

	await waitForStatusChange(blackjack, pairHandId, Status.AWAITING_SPLIT, 'split-deal');
	const splitCards = await getCards(blackjack, pairHandId);
	const ss1 = await blackjack.getSplitDetails(pairHandId);
	console.log(`    hand1: cards=${JSON.stringify(splitCards.player)} activeHand=${ss1.activeHand}`);
	console.log(
		`    hand2: cards=${JSON.stringify(
			ss1.player2Cards.map((x) => Number(x)).slice(0, Number(ss1.player2CardCount))
		)}`
	);

	/* =================== Phase 3: stand both hands (simplest flow) =================== */

	console.log(`\n=== Phase 3: stand on each split hand ===`);

	// Stand on hand 1 — synchronous advance, no VRF
	const stand1Rc = await logGas(await blackjack.stand(pairHandId), 'stand(hand1)');
	const afterStand1 = await blackjack.getSplitDetails(pairHandId);
	console.log(`    activeHand now: ${afterStand1.activeHand} (expected 2)`);

	// Stand on hand 2 — triggers dealer VRF
	const stand2Rc = await logGas(await blackjack.stand(pairHandId), 'stand(hand2)');
	const finalD = await waitForStatusChange(
		blackjack,
		pairHandId,
		Status.AWAITING_STAND,
		'dealer-resolve'
	);
	const finalCards = await getCards(blackjack, pairHandId);
	const finalSS = await blackjack.getSplitDetails(pairHandId);
	const finalBase = await blackjack.getHandBase(pairHandId);

	console.log(`\n=== Final result ===`);
	console.log(`  dealer cards: ${JSON.stringify(finalCards.dealer)}`);
	console.log(
		`  hand1 cards=${JSON.stringify(finalCards.player)}  result=${
			ResultName[Number(finalD.result)]
		}  payout=${ethers.formatUnits(finalBase.payout - finalSS.payout2, 6)}`
	);
	console.log(
		`  hand2 cards=${JSON.stringify(
			finalSS.player2Cards.map((x) => Number(x)).slice(0, Number(finalSS.player2CardCount))
		)}  result=${ResultName[Number(finalSS.result2)]}  payout=${ethers.formatUnits(
			finalSS.payout2,
			6
		)}`
	);
	console.log(`  total payout: ${ethers.formatUnits(finalBase.payout, 6)} USDC`);
	console.log(`\n=== Live test complete ===`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
