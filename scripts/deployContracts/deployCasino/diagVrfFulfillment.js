const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

const TX_HASH = process.env.TX_HASH;
if (!TX_HASH) throw new Error('set TX_HASH');

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
const ActionName = ['NONE', 'DEAL', 'HIT', 'STAND', 'DOUBLE_DOWN', 'SPLIT'];

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	console.log(`Network: ${network}`);
	console.log(`Tx:      ${TX_HASH}`);

	const tx = await ethers.provider.getTransaction(TX_HASH);
	const rc = await ethers.provider.getTransactionReceipt(TX_HASH);
	console.log(`From:    ${tx.from}`);
	console.log(`To:      ${tx.to}`);
	console.log(`Block:   ${rc.blockNumber}`);
	console.log(`Status:  ${rc.status === 1 ? 'SUCCESS' : 'FAILED'}`);
	console.log(`Gas used / limit: ${rc.gasUsed} / ${tx.gasLimit}`);

	// Decode Chainlink VRF coordinator events (v2.5)
	// event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium);
	const vrfAbi = [
		'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium)',
		'event RandomWordsRequested(bytes32 indexed keyHash, uint256 requestId, uint256 preSeed, uint256 indexed subId, uint16 minimumRequestConfirmations, uint32 callbackGasLimit, uint32 numWords, bytes extraArgs, address indexed sender)',
	];
	const iface = new ethers.Interface(vrfAbi);

	console.log('\n=== VRF Coordinator events in this tx ===');
	let fulfilledRequestId = null;
	for (const log of rc.logs) {
		try {
			const parsed = iface.parseLog(log);
			if (!parsed) continue;
			if (parsed.name === 'RandomWordsFulfilled') {
				fulfilledRequestId = parsed.args.requestId;
				console.log(`RandomWordsFulfilled:`);
				console.log(`  requestId:     ${parsed.args.requestId}`);
				console.log(`  success:       ${parsed.args.success}`);
				console.log(`  payment:       ${parsed.args.payment}`);
				console.log(`  nativePayment: ${parsed.args.nativePayment}`);
				console.log(`  onlyPremium:   ${parsed.args.onlyPremium}`);
				console.log(`  subId:         ${parsed.args.subId}`);
			} else if (parsed.name === 'RandomWordsRequested') {
				console.log(`RandomWordsRequested (fresh request in same tx — nested!):`);
				console.log(`  requestId:    ${parsed.args.requestId}`);
				console.log(`  numWords:     ${parsed.args.numWords}`);
				console.log(`  gasLimit:     ${parsed.args.callbackGasLimit}`);
				console.log(`  sender:       ${parsed.args.sender}`);
			}
		} catch {}
	}

	if (fulfilledRequestId === null) {
		console.log('  (no RandomWordsFulfilled event — unusual)');
		return;
	}

	// Look up which Blackjack hand this requestId belongs to
	const bjAddr = getTargetAddress('Blackjack', network);
	const bj = await ethers.getContractAt('Blackjack', bjAddr);
	const vrfReq = await bj.vrfRequests(fulfilledRequestId);
	console.log(`\n=== vrfRequests[${fulfilledRequestId}] ===`);
	console.log(`  handId: ${vrfReq.handId}`);
	console.log(`  action: ${vrfReq.action} (${ActionName[Number(vrfReq.action)]})`);

	if (vrfReq.handId === 0n) {
		console.log('  (unknown requestId — not tied to any Blackjack hand)');
		return;
	}

	const base = await bj.getHandBase(vrfReq.handId);
	const details = await bj.getHandDetails(vrfReq.handId);
	const cards = await bj.getHandCards(vrfReq.handId);
	const isSplit = await bj.isSplit(vrfReq.handId);
	console.log(`\n=== Hand ${vrfReq.handId} current state ===`);
	console.log(`  user:            ${base.user}`);
	console.log(`  amount:          ${base.amount}`);
	console.log(`  payout:          ${base.payout}`);
	console.log(`  status:          ${details.status} (${StatusName[Number(details.status)]})`);
	console.log(
		`  playerCardCount: ${details.playerCardCount}  cards: [${cards.playerCards
			.map((x) => Number(x))
			.join(', ')}]`
	);
	console.log(
		`  dealerCardCount: ${details.dealerCardCount}  cards: [${cards.dealerCards
			.map((x) => Number(x))
			.join(', ')}]`
	);
	console.log(`  isSplit:         ${isSplit}`);
	console.log(`  current pending requestId: ${base.requestId}`);
	if (isSplit) {
		const ss = await bj.getSplitDetails(vrfReq.handId);
		console.log(`  splitState:`);
		console.log(`    activeHand:      ${ss.activeHand}`);
		console.log(`    isAceSplit:      ${ss.isAceSplit}`);
		console.log(
			`    player2CardCount:${ss.player2CardCount}  cards:[${ss.player2Cards
				.map((x) => Number(x))
				.slice(0, Number(ss.player2CardCount))
				.join(', ')}]`
		);
	}

	const cbGas = await bj.callbackGasLimit();
	console.log(`\n  current callbackGasLimit: ${cbGas}`);
	console.log(`  tx gas used / available budget: ${rc.gasUsed} / ${tx.gasLimit}`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
