// ============================================================================
// Blackjack Strategy Audit — 100k hands per strategy on the H17 contract
// (any-2-card double, no split, no surrender, BJ 3:2, infinite deck).
//
// Each strategy is a pure function (playerCards, dealerUpcardRank) → decision.
// The runner reports empirical RTP & edge every 10k hands.
//
// Run one strategy:
//   npx hardhat test --no-compile test/contracts/Overtime/Casino/BlackjackStrategies.js \
//     --grep "BJ Strategy: Basic Full"
// ============================================================================

const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('1000');
const CANCEL_TIMEOUT = 3600n;
const BET_USDC = 3n * 1_000_000n; // 3 USDC per hand

const NUM_HANDS = Number(process.env.BJ_NUM_HANDS || 100000);
const LOG_EVERY = Number(process.env.BJ_LOG_EVERY || 10000);

// ============================================================================
// Fixture — fresh token / manager / VRF / Blackjack proxy per test
// ============================================================================
async function sharedFixture() {
	const [owner, player] = await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddress = await usdc.getAddress();
	for (let i = 0; i < 100; i++) await usdc.mintForUser(owner.address);

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
	const wethAddress = await weth.getAddress();
	const overAddress = await over.getAddress();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddress, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddress, OVER_PRICE);
	const priceFeedAddress = await priceFeed.getAddress();

	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(SportsAMMV2Manager, [owner.address]);
	const managerAddress = await manager.getAddress();

	const MockVRFCoordinator = await ethers.getContractFactory('MockVRFCoordinator');
	const vrfCoordinator = await MockVRFCoordinator.deploy();
	const vrfCoordinatorAddress = await vrfCoordinator.getAddress();

	const core = {
		owner: owner.address,
		manager: managerAddress,
		priceFeed: priceFeedAddress,
		vrfCoordinator: vrfCoordinatorAddress,
	};
	const collateralConfig = {
		usdc: usdcAddress,
		weth: wethAddress,
		over: overAddress,
		wethPriceFeedKey: WETH_KEY,
		overPriceFeedKey: OVER_KEY,
	};
	const vrfConfig = {
		subscriptionId: 1,
		keyHash: ethers.ZeroHash,
		callbackGasLimit: 500000,
		requestConfirmations: 3,
		nativePayment: false,
	};

	return { owner, player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig };
}

function seedWord(i, salt = 0) {
	return BigInt(
		ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [i, salt]))
	);
}

function parseEvent(contract, receipt, name) {
	for (const log of receipt.logs) {
		try {
			const parsed = contract.interface.parseLog(log);
			if (parsed?.name === name) return parsed;
		} catch {}
	}
	return null;
}

// ============================================================================
// Card math — mirrors contract _deriveCard / _calculateHandValue
// ============================================================================
function cardPoints(rank) {
	if (rank === 1) return 11;
	if (rank >= 11) return 10;
	return rank;
}
function calcHandValue(cards) {
	let total = 0;
	let aces = 0;
	for (const r of cards) {
		if (r === 1) {
			aces++;
			total += 11;
		} else total += cardPoints(r);
	}
	while (total > 21 && aces > 0) {
		total -= 10;
		aces--;
	}
	return { total, isSoft: aces > 0 };
}

// Map dealer upcard rank (1-13) to column index 0..9 for 2,3,4,5,6,7,8,9,10,A
function upcardIdx(rank) {
	if (rank === 1) return 9;
	if (rank >= 10) return 8;
	return rank - 2;
}

// ============================================================================
// Basic-strategy charts (H17 multi-deck — canonical; Wizard of Odds / Schlesinger)
// Rows: hard 5-20 / soft A,2-A,9
// Cols: dealer upcard 2,3,4,5,6,7,8,9,10,A  (indices 0..9)
// Codes: H=Hit, S=Stand, D=Double-or-Hit, d=Double-or-Stand
// (No pair/split rows: contract doesn't support split.)
// ============================================================================
const BS_H17_HARD = [
	'HHHHHHHHHH', // 5
	'HHHHHHHHHH', // 6
	'HHHHHHHHHH', // 7
	'HHHHHHHHHH', // 8
	'HDDDDHHHHH', // 9
	'DDDDDDDDHH', // 10
	'DDDDDDDDDD', // 11  (H17: double vs A)
	'HHSSSHHHHH', // 12
	'SSSSSHHHHH', // 13
	'SSSSSHHHHH', // 14
	'SSSSSHHHHH', // 15
	'SSSSSHHHHH', // 16
	'SSSSSSSSSS', // 17
	'SSSSSSSSSS', // 18
	'SSSSSSSSSS', // 19
	'SSSSSSSSSS', // 20
];
const BS_H17_SOFT = [
	'HHHDDHHHHH', // A,2 (13)
	'HHHDDHHHHH', // A,3 (14)
	'HHDDDHHHHH', // A,4 (15)
	'HHDDDHHHHH', // A,5 (16)
	'HDDDDHHHHH', // A,6 (17)
	'dddddSSHHH', // A,7 (18)  H17: Ds vs 2, H vs A
	'SSSSdSSSSS', // A,8 (19)  H17: Ds vs 6
	'SSSSSSSSSS', // A,9 (20)
];
// S17 diffs: 11 vs A → H; A,7 vs 2 → S; A,8 vs 6 → S
const BS_S17_HARD = [
	'HHHHHHHHHH',
	'HHHHHHHHHH',
	'HHHHHHHHHH',
	'HHHHHHHHHH',
	'HDDDDHHHHH',
	'DDDDDDDDHH',
	'DDDDDDDDDH', // 11  (S17: H vs A)
	'HHSSSHHHHH',
	'SSSSSHHHHH',
	'SSSSSHHHHH',
	'SSSSSHHHHH',
	'SSSSSHHHHH',
	'SSSSSSSSSS',
	'SSSSSSSSSS',
	'SSSSSSSSSS',
	'SSSSSSSSSS',
];
const BS_S17_SOFT = [
	'HHHDDHHHHH',
	'HHHDDHHHHH',
	'HHDDDHHHHH',
	'HHDDDHHHHH',
	'HDDDDHHHHH',
	'SddddSSHHH', // A,7 (S17: S vs 2)
	'SSSSSSSSSS', // A,8 (S17: S vs 6)
	'SSSSSSSSSS',
];

function chartDecision(hardChart, softChart, playerCards, dealerRank) {
	const { total, isSoft } = calcHandValue(playerCards);
	const col = upcardIdx(dealerRank);
	const canDouble = playerCards.length === 2;

	let code;
	if (isSoft) {
		const row = total - 13; // A,2=13 → 0
		if (row < 0 || row >= softChart.length) {
			// Soft 12 (A,A) — treat as A,1 → hit always
			return 'hit';
		}
		code = softChart[row][col];
	} else {
		if (total >= 21) return 'stand';
		if (total < 5) return 'hit';
		const row = total - 5;
		code = hardChart[row][col];
	}
	if (code === 'H') return 'hit';
	if (code === 'S') return 'stand';
	if (code === 'D') return canDouble ? 'double' : 'hit';
	if (code === 'd') return canDouble ? 'double' : 'stand';
	return 'stand';
}

// ============================================================================
// Ten strategies. Each (playerCards, dealerRank) → 'hit' | 'stand' | 'double'.
// ============================================================================

// 1. Mimic dealer (H17 — hit soft 17)
function sMimicDealer(playerCards) {
	const { total, isSoft } = calcHandValue(playerCards);
	if (total >= 18) return 'stand';
	if (total === 17) return isSoft ? 'hit' : 'stand';
	return 'hit';
}

// 2. Always stand
function sAlwaysStand() {
	return 'stand';
}

// 3. Never-bust (stand on any hard 12+)
function sNeverBust(playerCards) {
	const { total, isSoft } = calcHandValue(playerCards);
	if (isSoft) return total >= 18 ? 'stand' : 'hit';
	return total >= 12 ? 'stand' : 'hit';
}

// 4. Basic strategy, hit/stand only (no double)
function sBasicNoDouble(playerCards, dealerRank) {
	const d = chartDecision(BS_H17_HARD, BS_H17_SOFT, playerCards, dealerRank);
	return d === 'double' ? 'hit' : d;
}

// 5. Basic strategy, full H17 doubles
function sBasicH17(playerCards, dealerRank) {
	return chartDecision(BS_H17_HARD, BS_H17_SOFT, playerCards, dealerRank);
}

// 6. Basic strategy + static deviations (16 v10 S, 15 v10 S, 12 v3 S)
function sBasicDeviations(playerCards, dealerRank) {
	const { total, isSoft } = calcHandValue(playerCards);
	const col = upcardIdx(dealerRank);
	if (!isSoft) {
		if (total === 16 && col === 8) return 'stand';
		if (total === 15 && col === 8) return 'stand';
		if (total === 12 && col === 1) return 'stand';
	}
	return chartDecision(BS_H17_HARD, BS_H17_SOFT, playerCards, dealerRank);
}

// 7. Aggressive doubler (doubles 9 v2-6, 10 v any, 11 v any, A6-A8 v 3-6)
function sAggressive(playerCards, dealerRank) {
	const canDouble = playerCards.length === 2;
	const { total, isSoft } = calcHandValue(playerCards);
	const col = upcardIdx(dealerRank); // 0=2,5=7,9=A

	if (canDouble) {
		if (!isSoft) {
			if (total === 9 && col <= 4) return 'double';
			if (total === 10) return 'double';
			if (total === 11) return 'double';
		} else {
			const softVal = total - 11; // A,X value
			if (softVal >= 6 && softVal <= 8 && col >= 1 && col <= 4) return 'double';
		}
	}
	// Fallback to BS hit/stand (doubles already handled; collapse 'double' to hit)
	const d = chartDecision(BS_H17_HARD, BS_H17_SOFT, playerCards, dealerRank);
	return d === 'double' ? 'hit' : d;
}

// 8. ChatGPT Conservative (stand 12-16 only v 4-6, hit otherwise; doubles 10/11 v 2-6 & A6/A7 v 5-6)
function sChatGPTConservative(playerCards, dealerRank) {
	const canDouble = playerCards.length === 2;
	const { total, isSoft } = calcHandValue(playerCards);
	const col = upcardIdx(dealerRank); // 0=2, 1=3, 2=4, 3=5, 4=6

	if (canDouble && !isSoft) {
		if ((total === 10 || total === 11) && col <= 4) return 'double';
	}
	if (canDouble && isSoft) {
		const softVal = total - 11;
		if ((softVal === 6 || softVal === 7) && (col === 3 || col === 4)) return 'double';
	}

	if (isSoft) {
		return total < 18 ? 'hit' : 'stand';
	}
	if (total >= 17) return 'stand';
	if (total >= 12 && total <= 16) {
		return col >= 2 && col <= 4 ? 'stand' : 'hit'; // only stand vs 4,5,6
	}
	return 'hit';
}

// 9. Simple Cheat Rule (dealer 2-6: stand+double; 7-A: hit more; 11→D; 17+→S)
function sSimpleCheat(playerCards, dealerRank) {
	const canDouble = playerCards.length === 2;
	const { total, isSoft } = calcHandValue(playerCards);
	const col = upcardIdx(dealerRank); // 0..4 = dealer 2-6, 5..9 = 7-A

	if (canDouble && !isSoft && total === 11) return 'double';
	if (!isSoft && total >= 17) return 'stand';
	if (isSoft && total >= 18) return 'stand';

	if (col <= 4) {
		// Dealer 2-6
		if (canDouble && !isSoft && total === 10) return 'double';
		if (!isSoft && total >= 12) return 'stand';
		if (isSoft) return total >= 18 ? 'stand' : 'hit';
		return 'hit';
	}
	// Dealer 7-A
	return 'hit';
}

// 10. S17 basic strategy applied to H17 table (quantifies mismatch penalty)
function sS17InH17(playerCards, dealerRank) {
	return chartDecision(BS_S17_HARD, BS_S17_SOFT, playerCards, dealerRank);
}

// ============================================================================
// Split charts — basic strategy pair-splitting rules (DAS allowed, H17)
// Returns true if strategy wants to split the given starting pair.
// ============================================================================
function shouldSplitBasic(playerCards, dealerRank) {
	if (playerCards.length !== 2) return false;
	if (cardPoints(playerCards[0]) !== cardPoints(playerCards[1])) return false;
	// Use rank 1 (Ace) explicitly; 10-value (10,J,Q,K) treat as "10"
	const r = playerCards[0];
	const col = upcardIdx(dealerRank); // 0=2,5=7,9=A
	if (r === 1) return true; // A,A — always
	// 10-value pair (never split per basic strategy)
	if (cardPoints(r) === 10) return false;
	if (r === 8) return true; // always
	if (r === 9) return col <= 8 && col !== 5; // vs 2-9 except 7
	if (r === 7) return col <= 5; // vs 2-7
	if (r === 6) return col <= 4; // vs 2-6
	if (r === 5) return false;
	if (r === 4) return col === 3 || col === 4; // vs 5,6 (with DAS)
	if (r === 3 || r === 2) return col <= 5; // vs 2-7
	return false;
}
// Aggressive: split every non-10 pair (simulates "split everything splittable")
function shouldSplitAggressive(playerCards) {
	if (playerCards.length !== 2) return false;
	if (cardPoints(playerCards[0]) !== cardPoints(playerCards[1])) return false;
	if (cardPoints(playerCards[0]) === 10) return false; // even aggro shouldn't split 10s
	return true;
}
// Conservative: split only aces (safe baseline for the feature)
function shouldSplitAcesOnly(playerCards) {
	if (playerCards.length !== 2) return false;
	return playerCards[0] === 1 && playerCards[1] === 1;
}

const STRATEGIES = [
	{ name: 'Mimic Dealer (H17)', fn: sMimicDealer, canDouble: false },
	{ name: 'Always Stand', fn: sAlwaysStand, canDouble: false },
	{ name: 'Never Bust (stand 12+)', fn: sNeverBust, canDouble: false },
	{ name: 'Basic Strategy (no double)', fn: sBasicNoDouble, canDouble: false },
	{ name: 'Basic Strategy (H17 full)', fn: sBasicH17, canDouble: true },
	{ name: 'Basic + Deviations', fn: sBasicDeviations, canDouble: true },
	{ name: 'Aggressive Doubler', fn: sAggressive, canDouble: true },
	{ name: 'ChatGPT Conservative', fn: sChatGPTConservative, canDouble: true },
	{ name: 'Simple Cheat Rule', fn: sSimpleCheat, canDouble: true },
	{ name: 'S17 Chart vs H17 Dealer', fn: sS17InH17, canDouble: true },
	// Split-enabled strategies (canDouble must be true — post-split doubles add EV)
	{ name: 'Basic H17 + Split', fn: sBasicH17, canDouble: true, splitFn: shouldSplitBasic },
	{
		name: 'Basic + Deviations + Split',
		fn: sBasicDeviations,
		canDouble: true,
		splitFn: shouldSplitBasic,
	},
	{
		name: 'Aggressive Splitter',
		fn: sBasicH17,
		canDouble: true,
		splitFn: shouldSplitAggressive,
	},
	{ name: 'Ace-Only Split', fn: sBasicH17, canDouble: true, splitFn: shouldSplitAcesOnly },
];

// ============================================================================
// Hand runner — deals a hand, plays through the decision loop, logs result.
// ============================================================================
async function runStrategy(name, strategy, ctx) {
	const strategyFn = strategy.fn;
	const splitFn = strategy.splitFn || null;
	const { bj, bjAddress, usdc, player, usdcAddress, vrfCoordinator } = ctx;

	const results = {
		blackjack: 0,
		win: 0,
		push: 0,
		loss: 0,
		bust: 0,
		doubleWin: 0,
		doubleLoss: 0,
		doublePush: 0,
	};
	let hitCount = 0;
	let standCount = 0;
	let doubleCount = 0;
	let splitCount = 0;
	let chunkStartBalance = await usdc.balanceOf(player.address);
	const totalStartBalance = chunkStartBalance;

	// Tally one sub-hand's result into `results`. For split hands we call this twice
	// (once per sub-hand) with each sub-hand's HandResult enum.
	function tallyResult(resultEnum, wasDouble) {
		if (resultEnum === 1) results.blackjack++;
		else if (resultEnum === 2 || resultEnum === 6) {
			results.win++;
			if (wasDouble) results.doubleWin++;
		} else if (resultEnum === 4) {
			results.push++;
			if (wasDouble) results.doublePush++;
		} else if (resultEnum === 5) results.bust++;
		else {
			results.loss++;
			if (wasDouble) results.doubleLoss++;
		}
	}

	for (let i = 1; i <= NUM_HANDS; i++) {
		const placeTx = await bj.connect(player).placeBet(usdcAddress, BET_USDC, ethers.ZeroAddress);
		const placeReceipt = await placeTx.wait();
		const created = parseEvent(bj, placeReceipt, 'HandCreated');
		const handId = created.args.handId;
		const dealRequestId = created.args.requestId;

		const dealWord1 = seedWord(i, 6);
		const dealWord2 = seedWord(i, 66);
		await vrfCoordinator.fulfillRandomWords(bjAddress, dealRequestId, [dealWord1, dealWord2]);

		let details = await bj.getHandDetails(handId);
		if (details.status === 6n) {
			// Natural-BJ resolved immediately (not splittable)
			const r = Number(details.result);
			if (r === 1) results.blackjack++;
			else if (r === 3) results.loss++;
			else if (r === 4) results.push++;
		} else {
			// Check if strategy wants to split right at the top (before any hit)
			let didSplit = false;
			if (splitFn) {
				const cards = await bj.getHandCards(handId);
				const playerCards = cards.playerCards.map((c) => Number(c));
				const dealerUp = Number(cards.dealerCards[0]);
				if (splitFn(playerCards, dealerUp)) {
					const isAceSplit = playerCards[0] === 1 && playerCards[1] === 1;
					const splitTx = await bj.connect(player).split(handId);
					const splitReceipt = await splitTx.wait();
					const splitEvent = parseEvent(bj, splitReceipt, 'HandSplit');
					const wordCount = isAceSplit ? 9 : 2;
					const splitWords = [];
					for (let w = 0; w < wordCount; w++) splitWords.push(seedWord(i * 1000 + w, 11));
					await vrfCoordinator.fulfillRandomWords(bjAddress, splitEvent.args.requestId, splitWords);
					splitCount++;
					didSplit = true;
				}
			}

			if (didSplit) {
				// Play through both split hands (ace split already RESOLVED, skip loop)
				let step = 0;
				let finalDet = await bj.getHandDetails(handId);
				while (finalDet.status === 2n && step < 30) {
					const ss = await bj.getSplitDetails(handId);
					const cards = await bj.getHandCards(handId);
					const dealerUp = Number(cards.dealerCards[0]);
					const active = Number(ss.activeHand);
					const activeCards =
						active === 1
							? cards.playerCards.map((c) => Number(c))
							: ss.player2Cards.map((c) => Number(c)).slice(0, Number(ss.player2CardCount));
					let decision = strategyFn(activeCards, dealerUp);
					if (decision === 'double' && activeCards.length !== 2) decision = 'hit';

					if (decision === 'hit') {
						hitCount++;
						const hitTx = await bj.connect(player).hit(handId);
						const hitReceipt = await hitTx.wait();
						const hitEvent = parseEvent(bj, hitReceipt, 'HitRequested');
						const hitWord = seedWord(i * 1000 + step, 7);
						await vrfCoordinator.fulfillRandomWords(bjAddress, hitEvent.args.requestId, [hitWord]);
					} else if (decision === 'double') {
						doubleCount++;
						const dTx = await bj.connect(player).doubleDown(handId);
						const dReceipt = await dTx.wait();
						const dEvent = parseEvent(bj, dReceipt, 'DoubleDownRequested');
						// Hand 1 double: 1 word. Hand 2 double: 7 words.
						const dWordCount = active === 1 ? 1 : 7;
						const dWords = [];
						for (let w = 0; w < dWordCount; w++) dWords.push(seedWord(i * 1000 + step * 10 + w, 9));
						await vrfCoordinator.fulfillRandomWords(bjAddress, dEvent.args.requestId, dWords);
					} else {
						standCount++;
						const sTx = await bj.connect(player).stand(handId);
						// Hand 1 stand is a sync advance (no VRF). Hand 2 stand fires dealer VRF.
						if (active === 2) {
							const sReceipt = await sTx.wait();
							const sEvent = parseEvent(bj, sReceipt, 'StandRequested');
							const sWords = [];
							for (let w = 0; w < 7; w++) sWords.push(seedWord(i * 1000 + step * 10 + w, 8));
							await vrfCoordinator.fulfillRandomWords(bjAddress, sEvent.args.requestId, sWords);
						}
					}

					// A hit that auto-stands at 21 (or busts hand 2 while hand 1 alive) fires an
					// in-callback StandRequested. Check for it and fulfill if present.
					if (decision === 'hit') {
						const d2 = await bj.getHandDetails(handId);
						if (d2.status === 4n) {
							// AWAITING_STAND — dealer VRF was kicked off inside the hit callback
							// We need to find the new requestId. The cleanest approach: query the
							// current hand.requestId which was updated by _registerVrf.
							const base = await bj.getHandBase(handId);
							const sWords = [];
							for (let w = 0; w < 7; w++) sWords.push(seedWord(i * 1000 + step * 10 + w + 100, 8));
							await vrfCoordinator.fulfillRandomWords(bjAddress, base.requestId, sWords);
						}
					}

					finalDet = await bj.getHandDetails(handId);
					step++;
				}

				// Parse split results: hand 1 from hand.result, hand 2 from splitDetails.result2
				const ss = await bj.getSplitDetails(handId);
				const r1 = Number(finalDet.result);
				const r2 = Number(ss.result2);
				tallyResult(r1, finalDet.isDoubledDown);
				tallyResult(r2, ss.isDoubled2);
			} else {
				// Non-split path (original logic)
				let step = 0;
				let resolved = false;
				while (details.status === 2n && step < 15 && !resolved) {
					const cards = await bj.getHandCards(handId);
					const playerCards = cards.playerCards.map((c) => Number(c));
					const dealerUp = Number(cards.dealerCards[0]);
					let decision = strategyFn(playerCards, dealerUp);

					if (decision === 'double' && playerCards.length !== 2) decision = 'hit';

					if (decision === 'hit') {
						hitCount++;
						const hitTx = await bj.connect(player).hit(handId);
						const hitReceipt = await hitTx.wait();
						const hitEvent = parseEvent(bj, hitReceipt, 'HitRequested');
						const hitWord = seedWord(i * 100 + step, 7);
						await vrfCoordinator.fulfillRandomWords(bjAddress, hitEvent.args.requestId, [hitWord]);
						// Check for auto-stand-at-21 kicking off dealer VRF in callback
						const d2 = await bj.getHandDetails(handId);
						if (d2.status === 4n) {
							const base = await bj.getHandBase(handId);
							const sWords = [];
							for (let w = 0; w < 7; w++) sWords.push(seedWord(i * 100 + step * 10 + w + 100, 8));
							await vrfCoordinator.fulfillRandomWords(bjAddress, base.requestId, sWords);
							resolved = true;
						}
					} else if (decision === 'double') {
						doubleCount++;
						const dTx = await bj.connect(player).doubleDown(handId);
						const dReceipt = await dTx.wait();
						const dEvent = parseEvent(bj, dReceipt, 'DoubleDownRequested');
						const dWords = [];
						for (let w = 0; w < 7; w++) dWords.push(seedWord(i * 100 + step * 10 + w, 9));
						await vrfCoordinator.fulfillRandomWords(bjAddress, dEvent.args.requestId, dWords);
						resolved = true;
					} else {
						standCount++;
						const sTx = await bj.connect(player).stand(handId);
						const sReceipt = await sTx.wait();
						const sEvent = parseEvent(bj, sReceipt, 'StandRequested');
						const sWords = [];
						for (let w = 0; w < 7; w++) sWords.push(seedWord(i * 100 + step * 10 + w, 8));
						await vrfCoordinator.fulfillRandomWords(bjAddress, sEvent.args.requestId, sWords);
						resolved = true;
					}

					if (!resolved) {
						details = await bj.getHandDetails(handId);
						step++;
					}
				}

				const finalDetails = await bj.getHandDetails(handId);
				tallyResult(Number(finalDetails.result), finalDetails.isDoubledDown);
			}
		}

		if (i % LOG_EVERY === 0) {
			const cur = await usdc.balanceOf(player.address);
			const chunkNet = Number(cur - chunkStartBalance) / 1e6;
			const totalNet = Number(cur - totalStartBalance) / 1e6;
			// Effective units wagered: base bets + doubles + splits (each adds 1 unit of BET_USDC)
			const effWageredUnits = i + doubleCount + splitCount;
			const effWageredUsdc = effWageredUnits * 3;
			const rtp = ((effWageredUsdc + totalNet) / effWageredUsdc) * 100;
			console.log(
				`  [${name}] hand ${i.toString().padStart(6)} | splits ${splitCount
					.toString()
					.padStart(5)} | doubles ${doubleCount.toString().padStart(5)} | chunkNet ${chunkNet
					.toFixed(2)
					.padStart(10)} USDC | totalNet ${totalNet
					.toFixed(2)
					.padStart(
						10
					)} USDC | effWagered ${effWageredUsdc.toLocaleString()} USDC | running RTP ${rtp.toFixed(
					3
				)}%`
			);
			chunkStartBalance = cur;
		}
	}

	const playerAfter = await usdc.balanceOf(player.address);
	const totalNet = Number(playerAfter - totalStartBalance) / 1e6;
	const effUnits = NUM_HANDS + doubleCount + splitCount;
	const effWagered = effUnits * 3;
	const rtp = ((effWagered + totalNet) / effWagered) * 100;

	console.log(`\n========== BJ STRATEGY: ${name} ==========`);
	console.log(`Hands: ${NUM_HANDS}`);
	console.log(
		`Actions: ${hitCount} hits, ${standCount} stands, ${doubleCount} doubles, ${splitCount} splits`
	);
	console.log(`Results:`);
	console.log(
		`  Natural BJ:   ${results.blackjack} (${((results.blackjack / NUM_HANDS) * 100).toFixed(2)}%)`
	);
	console.log(
		`  Player win:   ${results.win} (${((results.win / NUM_HANDS) * 100).toFixed(2)}%)  (of which ${
			results.doubleWin
		} after double)`
	);
	console.log(
		`  Push:         ${results.push} (${((results.push / NUM_HANDS) * 100).toFixed(
			2
		)}%)  (of which ${results.doublePush} after double)`
	);
	console.log(
		`  Player bust:  ${results.bust} (${((results.bust / NUM_HANDS) * 100).toFixed(2)}%)`
	);
	console.log(
		`  Dealer win:   ${results.loss} (${((results.loss / NUM_HANDS) * 100).toFixed(
			2
		)}%)  (of which ${results.doubleLoss} after double)`
	);
	console.log(`Effective wagered (incl. doubles): ${effWagered.toLocaleString()} USDC`);
	console.log(`Player net:    ${totalNet.toFixed(2)} USDC`);
	console.log(`Empirical RTP:  ${rtp.toFixed(3)}%`);
	console.log(`Empirical edge: ${(100 - rtp).toFixed(3)}%`);
	console.log(`==========================================\n`);

	return { rtp, edge: 100 - rtp };
}

async function setupBlackjack(f) {
	const { player, usdc, usdcAddress, vrfCoordinator, core, collateralConfig, vrfConfig } = f;
	const BjFactory = await ethers.getContractFactory('Blackjack');
	const bj = await upgrades.deployProxy(BjFactory, [], { initializer: false });
	const bjAddress = await bj.getAddress();
	await bj.initialize(core, collateralConfig, MAX_PROFIT_USD, CANCEL_TIMEOUT, vrfConfig);

	// Generous bankrolls: 200k each side (variance + doubles)
	await usdc.transfer(bjAddress, 200_000n * 1_000_000n);
	await usdc.transfer(player.address, 200_000n * 1_000_000n);
	// Allowance sized for all hands + full doubles (100% of hands doubled is an upper bound)
	// 5x allowance covers: base bet + split + 2 post-split doubles (worst case per hand)
	await usdc.connect(player).approve(bjAddress, BET_USDC * BigInt(NUM_HANDS * 5));

	return { bj, bjAddress, usdc, player, usdcAddress, vrfCoordinator };
}

// ============================================================================
// Mocha test cases — one per strategy. All share the same random seeds so
// differences reflect strategy, not luck.
// ============================================================================
describe('Blackjack Strategy Audit', () => {
	for (const strategy of STRATEGIES) {
		it(`BJ Strategy: ${strategy.name}`, async function () {
			this.timeout(18000000); // 300 min
			const f = await loadFixture(sharedFixture);
			const ctx = await setupBlackjack(f);
			const { rtp } = await runStrategy(strategy.name, strategy, ctx);
			expect(rtp).to.be.greaterThan(50); // sanity — even worst strategy should exceed 50%
		});
	}
});
