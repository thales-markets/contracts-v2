const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const TX_HASH =
	process.env.TX_HASH || '0x55f5e6fde5715a6c3d51afe8c5c106cd6e9059ff40afeddce16d6f6ad3afdc6e';

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
const ActionName = ['NONE', 'DEAL', 'HIT', 'STAND', 'DOUBLE_DOWN', 'SPLIT'];

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	console.log(`Network: ${network} (chain ${networkObj.chainId})\n`);
	console.log(`Tx: ${TX_HASH}`);

	const tx = await ethers.provider.getTransaction(TX_HASH);
	const rc = await ethers.provider.getTransactionReceipt(TX_HASH);
	console.log(`From:  ${tx.from}`);
	console.log(`To:    ${tx.to}`);
	console.log(`Block: ${rc.blockNumber}  Status: ${rc.status === 1 ? 'SUCCESS' : 'FAILED'}`);

	const bjAddr = getTargetAddress('Blackjack', network);
	const blackjack = await ethers.getContractAt('Blackjack', bjAddr);

	// Decode the input to determine which function was called
	const funcSelector = tx.data.slice(0, 10);
	const iface = blackjack.interface;
	const parsed = iface.parseTransaction({ data: tx.data });
	console.log(`\nFunction: ${parsed.name}(${parsed.args.map((a) => a.toString()).join(', ')})`);

	// Extract handId (first arg for hit/stand/double/split/cancel)
	const handId = BigInt(parsed.args[0]);
	console.log(`handId:   ${handId}\n`);

	// Parse all Blackjack events from the receipt
	console.log('=== Events emitted in this tx ===');
	for (const log of rc.logs) {
		if (log.address.toLowerCase() !== bjAddr.toLowerCase()) continue;
		try {
			const ev = iface.parseLog(log);
			console.log(`  ${ev.name}(${ev.args.map((a) => a.toString()).join(', ')})`);
		} catch {}
	}

	// Read current state of the hand
	console.log('\n=== Current state of hand ===');
	const base = await blackjack.getHandBase(handId);
	const details = await blackjack.getHandDetails(handId);
	const cards = await blackjack.getHandCards(handId);
	const isSplit = await blackjack.isSplit(handId);
	const isFreeBet = await blackjack.isFreeBet(handId);

	console.log(`  user:            ${base.user}`);
	console.log(`  collateral:      ${base.collateral}`);
	console.log(`  amount:          ${base.amount}`);
	console.log(`  payout:          ${base.payout}`);
	console.log(`  reservedProfit:  ${base.reservedProfit}`);
	console.log(`  placedAt:        ${new Date(Number(base.placedAt) * 1000).toISOString()}`);
	console.log(
		`  resolvedAt:      ${
			base.resolvedAt > 0n
				? new Date(Number(base.resolvedAt) * 1000).toISOString()
				: '(not resolved)'
		}`
	);
	console.log(`  requestId:       ${base.requestId}`);
	console.log(`  status:          ${details.status} (${StatusName[Number(details.status)]})`);
	console.log(`  result:          ${details.result} (${ResultName[Number(details.result)]})`);
	console.log(`  isDoubledDown:   ${details.isDoubledDown}`);
	console.log(`  isFreeBet:       ${isFreeBet}`);
	console.log(`  isSplit:         ${isSplit}`);
	console.log(`  playerCardCount: ${details.playerCardCount}`);
	console.log(`  dealerCardCount: ${details.dealerCardCount}`);
	console.log(`  playerCards:     [${cards.playerCards.map((x) => Number(x)).join(', ')}]`);
	console.log(`  dealerCards:     [${cards.dealerCards.map((x) => Number(x)).join(', ')}]`);

	if (isSplit) {
		const ss = await blackjack.getSplitDetails(handId);
		console.log('\n=== Split state ===');
		console.log(`  amount2:          ${ss.amount2}`);
		console.log(`  payout2:          ${ss.payout2}`);
		console.log(`  activeHand:       ${ss.activeHand}`);
		console.log(`  isAceSplit:       ${ss.isAceSplit}`);
		console.log(`  isDoubled2:       ${ss.isDoubled2}`);
		console.log(`  result2:          ${ss.result2} (${ResultName[Number(ss.result2)]})`);
		console.log(`  player2CardCount: ${ss.player2CardCount}`);
		console.log(
			`  player2Cards:     [${ss.player2Cards
				.map((x) => Number(x))
				.slice(0, Number(ss.player2CardCount))
				.join(', ')}]`
		);
	}

	// VRF request mapping
	const vrfReq = await blackjack.vrfRequests(base.requestId);
	const lastRequestAt = await blackjack.lastRequestAt(handId);
	const cancelTimeout = await blackjack.cancelTimeout();
	const now = Math.floor(Date.now() / 1000);
	console.log('\n=== Pending VRF request ===');
	console.log(`  requestId:       ${base.requestId}`);
	console.log(`  action:          ${vrfReq.action} (${ActionName[Number(vrfReq.action)]})`);
	console.log(`  handId (mapped): ${vrfReq.handId}`);
	console.log(`  lastRequestAt:   ${new Date(Number(lastRequestAt) * 1000).toISOString()}`);
	console.log(`  cancelTimeout:   ${cancelTimeout}s`);
	console.log(`  elapsed:         ${now - Number(lastRequestAt)}s`);
	console.log(
		`  cancellable at:  ${new Date(
			(Number(lastRequestAt) + Number(cancelTimeout)) * 1000
		).toISOString()}`
	);
	const canCancelNow = now >= Number(lastRequestAt) + Number(cancelTimeout);
	console.log(`  can user cancel now: ${canCancelNow}`);

	// Diagnose
	console.log('\n=== Diagnosis ===');
	const s = Number(details.status);
	if (s === 6) console.log('Hand is RESOLVED. Nothing stuck.');
	else if (s === 7) console.log('Hand is CANCELLED. Nothing stuck.');
	else if (s === 2)
		console.log('Hand is PLAYER_TURN — waiting for user action (hit / stand / double / split).');
	else if (s >= 1 && s <= 5) {
		console.log(`Hand is ${StatusName[s]} — waiting for VRF fulfillment.`);
		console.log(
			`VRF action pending: ${ActionName[Number(vrfReq.action)]}, requestId ${base.requestId}`
		);
		console.log(`Elapsed since last VRF request: ${now - Number(lastRequestAt)}s`);
		if (canCancelNow) {
			console.log(
				'→ Cancel timeout reached. User (or admin resolver) can call cancelHand / adminCancelHand to refund.'
			);
		} else {
			console.log(
				`→ Wait ${
					Number(lastRequestAt) + Number(cancelTimeout) - now
				}s for cancel timeout, or check VRF fulfillment status.`
			);
		}
	} else if (s === 8) {
		console.log('Hand is AWAITING_SPLIT — waiting for VRF fulfillment of the split deal.');
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
