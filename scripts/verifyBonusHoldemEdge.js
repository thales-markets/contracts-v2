/**
 * OvertimeBonusHoldem — pure-JS Monte Carlo edge verification.
 *
 * Game model (mirrors contract):
 *   - ANTE required (1 unit), optional BONUS sidebet (= ANTE in this sim)
 *   - Pre-flop: Play 2× ante OR fold
 *   - Flop: optional 1× raise OR check
 *   - Turn: optional 1× raise OR check
 *   - River: optional 1× raise OR check
 *   - No dealer qualification
 *   - Ante 1:1 on Straight+ when player wins; push on lower wins
 *   - Raises 1:1 on player win; push on tie; lose on dealer win
 *   - Bonus paytable per spec
 *
 * Strategy (roughly optimal for Texas Hold'em Bonus):
 *   Pre-flop play with: any pair / any Ace / K-x suited (x ≥ 2) / K-T+ off / Q-J / J-T suited
 *   Otherwise fold (loses ante, bonus still settles).
 *   Post-flop streets: raise with pair-or-better using hole card or strong draw; else check.
 *
 * Target: ~97.30% RTP per CoinPoker spec.
 *
 * Run: `node scripts/verifyBonusHoldemEdge.js`
 */

const SIM_ROUNDS = Number(process.env.N || 500_000);

const DECK_SIZE = 52;
const HandClass = {
	HIGH_CARD: 0,
	PAIR: 1,
	TWO_PAIR: 2,
	THREE_OF_A_KIND: 3,
	STRAIGHT: 4,
	FLUSH: 5,
	FULL_HOUSE: 6,
	FOUR_OF_A_KIND: 7,
	STRAIGHT_FLUSH: 8,
	ROYAL_FLUSH: 9,
};

const RANK_TEN = 10;
const RANK_JACK = 11;
const RANK_QUEEN = 12;
const RANK_KING = 13;
const RANK_ACE = 14;

const BONUS_MULT = {
	AA_VS_AA: 500,
	AA: 31,
	AK_S: 26,
	AQ_AJ_S: 21,
	AK: 16,
	JJ_QQ_KK: 11,
	AQ_AJ: 6,
	LOW_PAIR: 4,
};

function mulberry32(seed) {
	let s = seed >>> 0;
	return function () {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function rankOf(c) {
	return (c % 13) + 2;
}
function suitOf(c) {
	return (c / 13) | 0;
}

const deck = new Uint8Array(52);

function deal9(rng) {
	for (let i = 0; i < 52; i++) deck[i] = i;
	for (let i = 0; i < 9; i++) {
		const j = i + ((rng() * (52 - i)) | 0);
		const tmp = deck[i];
		deck[i] = deck[j];
		deck[j] = tmp;
	}
	return deck;
}

function findStraightTop(rankMask) {
	for (let top = 14; top >= 6; top--) {
		const fiveMask = (0x1f << (top - 4)) & 0xffff;
		if ((rankMask & fiveMask) === fiveMask) return top;
	}
	if ((rankMask & 0x4000) !== 0 && (rankMask & 0x3c) === 0x3c) return 5;
	return 0;
}

function topNRanks(mask, n) {
	const out = [];
	for (let r = 14; r >= 2 && out.length < n; r--) {
		if ((mask & (1 << r)) !== 0) out.push(r);
	}
	while (out.length < n) out.push(0);
	return out;
}
function topNExcluding(mask, n, ex0 = 0, ex1 = 0, ex2 = 0) {
	let m = mask;
	if (ex0) m &= ~(1 << ex0);
	if (ex1) m &= ~(1 << ex1);
	if (ex2) m &= ~(1 << ex2);
	return topNRanks(m, n);
}
function pack(class_, a = 0, b = 0, c = 0, d = 0, e = 0) {
	return (class_ << 20) | (a << 16) | (b << 12) | (c << 8) | (d << 4) | e;
}

function evaluateCards(cards) {
	const rankCount = new Array(15).fill(0);
	const suitCount = [0, 0, 0, 0];
	let rankMask = 0;
	const suitRankMask = [0, 0, 0, 0];
	for (const c of cards) {
		const r = rankOf(c);
		const s = suitOf(c);
		rankCount[r]++;
		suitCount[s]++;
		rankMask |= 1 << r;
		suitRankMask[s] |= 1 << r;
	}
	let flushSuit = -1;
	for (let s = 0; s < 4; s++)
		if (suitCount[s] >= 5) {
			flushSuit = s;
			break;
		}
	if (flushSuit >= 0) {
		const sfTop = findStraightTop(suitRankMask[flushSuit]);
		if (sfTop > 0) {
			if (sfTop === 14) return pack(HandClass.ROYAL_FLUSH, 14);
			return pack(HandClass.STRAIGHT_FLUSH, sfTop);
		}
	}
	let fourRank = 0,
		firstThree = 0,
		secondThree = 0,
		firstPair = 0,
		secondPair = 0;
	for (let r = 14; r >= 2; r--) {
		if (rankCount[r] === 4 && !fourRank) fourRank = r;
		else if (rankCount[r] === 3) {
			if (!firstThree) firstThree = r;
			else if (!secondThree) secondThree = r;
		} else if (rankCount[r] === 2) {
			if (!firstPair) firstPair = r;
			else if (!secondPair) secondPair = r;
		}
	}
	if (fourRank) {
		const k = topNExcluding(rankMask, 1, fourRank)[0];
		return pack(HandClass.FOUR_OF_A_KIND, fourRank, k);
	}
	if (firstThree > 0 && (secondThree > 0 || firstPair > 0)) {
		const pairRank = secondThree > firstPair ? secondThree : firstPair;
		return pack(HandClass.FULL_HOUSE, firstThree, pairRank);
	}
	if (flushSuit >= 0) {
		const t5 = topNRanks(suitRankMask[flushSuit], 5);
		return pack(HandClass.FLUSH, t5[0], t5[1], t5[2], t5[3], t5[4]);
	}
	const straightTop = findStraightTop(rankMask);
	if (straightTop > 0) return pack(HandClass.STRAIGHT, straightTop);
	if (firstThree > 0) {
		const ks = topNExcluding(rankMask, 2, firstThree);
		return pack(HandClass.THREE_OF_A_KIND, firstThree, ks[0], ks[1]);
	}
	if (firstPair > 0 && secondPair > 0) {
		const ks = topNExcluding(rankMask, 1, firstPair, secondPair);
		return pack(HandClass.TWO_PAIR, firstPair, secondPair, ks[0]);
	}
	if (firstPair > 0) {
		const ks = topNExcluding(rankMask, 3, firstPair);
		return pack(HandClass.PAIR, firstPair, ks[0], ks[1], ks[2]);
	}
	const hc = topNRanks(rankMask, 5);
	return pack(HandClass.HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
}

function unpackClass(h) {
	return (h >> 20) & 0xf;
}

// Pre-flop strategy ~ Wizard of Odds Texas Hold'em Bonus chart (~65-70% play rate, ~30-35% fold)
function shouldPlayPreFlop(hole) {
	const r0 = rankOf(hole[0]);
	const r1 = rankOf(hole[1]);
	const s0 = suitOf(hole[0]);
	const s1 = suitOf(hole[1]);
	const hi = Math.max(r0, r1);
	const lo = Math.min(r0, r1);
	const suited = s0 === s1;
	if (r0 === r1) return true; // any pair
	if (hi === RANK_ACE) return true; // any Ace, any suit
	if (suited) {
		// Suited: play almost everything down to medium connectors
		if (hi >= RANK_KING) return true; // K-x suited
		if (hi === RANK_QUEEN && lo >= 5) return true; // Q-5+ suited
		if (hi === RANK_JACK && lo >= 7) return true; // J-7+ suited
		if (hi === RANK_TEN && lo >= 7) return true; // T-7+ suited
		if (hi === 9 && lo >= 7) return true; // 9-7+ suited
	} else {
		// Offsuit: tighter; need either high cards or connector
		if (hi === RANK_KING && lo >= 9) return true; // K-9+ off
		if (hi === RANK_QUEEN && lo >= RANK_TEN) return true; // Q-T+ off
		if (hi === RANK_JACK && lo >= RANK_TEN) return true; // J-T off
	}
	return false;
}

// Post-flop strategy: more conservative — only raise on solid made hands using hole cards.
// Raises commit more money; with optional check available, only raise when clearly +EV.
function shouldRaiseStreet(hole, communitySoFar) {
	const cards = [...hole, ...communitySoFar];
	const ev = evaluateCards(cards);
	const cls = unpackClass(ev);
	// Raise on TwoPair+ regardless of which cards make it
	if (cls >= HandClass.THREE_OF_A_KIND) return true;
	// TwoPair: must use at least one hole card
	if (cls === HandClass.TWO_PAIR) {
		const hiPair = (ev >> 16) & 0xf;
		const loPair = (ev >> 12) & 0xf;
		const r0 = rankOf(hole[0]);
		const r1 = rankOf(hole[1]);
		if (r0 === hiPair || r1 === hiPair || r0 === loPair || r1 === loPair) return true;
	}
	// Pair: only raise if top pair (pair rank == highest community card) using hole card
	if (cls === HandClass.PAIR) {
		const pairRank = (ev >> 16) & 0xf;
		const r0 = rankOf(hole[0]);
		const r1 = rankOf(hole[1]);
		const usesHole = r0 === pairRank || r1 === pairRank;
		if (!usesHole) return false;
		// Is it top pair? Compare to highest community card
		const commHi = Math.max(...communitySoFar.map(rankOf));
		if (pairRank >= commHi) return true;
		return false;
	}
	return false;
}

function bonusMult(hole, dealerHole) {
	const pr0 = rankOf(hole[0]);
	const pr1 = rankOf(hole[1]);
	const ps0 = suitOf(hole[0]);
	const ps1 = suitOf(hole[1]);
	const dr0 = rankOf(dealerHole[0]);
	const dr1 = rankOf(dealerHole[1]);
	const playerAA = pr0 === RANK_ACE && pr1 === RANK_ACE;
	const dealerAA = dr0 === RANK_ACE && dr1 === RANK_ACE;
	if (playerAA && dealerAA) return BONUS_MULT.AA_VS_AA;
	if (playerAA) return BONUS_MULT.AA;
	const isPair = pr0 === pr1;
	const hi = Math.max(pr0, pr1);
	const lo = Math.min(pr0, pr1);
	const suited = ps0 === ps1;
	if (!isPair && hi === RANK_ACE) {
		if (suited) {
			if (lo === RANK_KING) return BONUS_MULT.AK_S;
			if (lo === RANK_QUEEN || lo === RANK_JACK) return BONUS_MULT.AQ_AJ_S;
		} else {
			if (lo === RANK_KING) return BONUS_MULT.AK;
			if (lo === RANK_QUEEN || lo === RANK_JACK) return BONUS_MULT.AQ_AJ;
		}
		return 0;
	}
	if (isPair) {
		if (pr0 === RANK_JACK || pr0 === RANK_QUEEN || pr0 === RANK_KING) return BONUS_MULT.JJ_QQ_KK;
		if (pr0 >= 2 && pr0 <= RANK_TEN) return BONUS_MULT.LOW_PAIR;
	}
	return 0;
}

function runSim() {
	const rng = mulberry32(0xc0deba5e);
	const ante = 1;
	const bonus = 1;
	let totalAnteWagered = 0;
	let totalWagered = 0;
	let totalReturn = 0;
	let mainWagered = 0;
	let mainReturn = 0;
	const outcomes = { play: 0, fold: 0, win: 0, loss: 0, tie: 0 };

	for (let i = 0; i < SIM_ROUNDS; i++) {
		const d = deal9(rng);
		const hole = [d[0], d[1]];
		const flop = [d[2], d[3], d[4]];
		const turn = d[5];
		const river = d[6];
		const community = [d[2], d[3], d[4], d[5], d[6]];
		const dealerHole = [d[7], d[8]];

		totalAnteWagered += ante;

		// Pre-flop decision
		if (!shouldPlayPreFlop(hole)) {
			outcomes.fold++;
			// Player loses ante; bonus settles independently
			const bonusM = bonusMult(hole, dealerHole);
			const bonusPay = bonusM === 0 ? 0 : bonus * bonusM;
			totalWagered += ante + bonus;
			totalReturn += bonusPay;
			mainWagered += ante;
			mainReturn += 0;
			continue;
		}
		outcomes.play++;

		const playStake = 2 * ante;
		const flopRaise = shouldRaiseStreet(hole, flop) ? ante : 0;
		const turnRaise = shouldRaiseStreet(hole, [...flop, turn]) ? ante : 0;
		const riverRaise = shouldRaiseStreet(hole, community) ? ante : 0;

		const playerSeven = [...hole, ...community];
		const dealerSeven = [...dealerHole, ...community];
		const pVal = evaluateCards(playerSeven);
		const dVal = evaluateCards(dealerSeven);

		let antePay = 0,
			playPay = 0,
			flopPay = 0,
			turnPay = 0,
			riverPay = 0;
		if (pVal > dVal) {
			outcomes.win++;
			antePay = ante * (unpackClass(pVal) >= HandClass.STRAIGHT ? 2 : 1);
			playPay = playStake * 2;
			flopPay = flopRaise * 2;
			turnPay = turnRaise * 2;
			riverPay = riverRaise * 2;
		} else if (pVal < dVal) {
			outcomes.loss++;
		} else {
			outcomes.tie++;
			antePay = ante;
			playPay = playStake;
			flopPay = flopRaise;
			turnPay = turnRaise;
			riverPay = riverRaise;
		}
		const mainPay = antePay + playPay + flopPay + turnPay + riverPay;
		const mainStake = ante + playStake + flopRaise + turnRaise + riverRaise;
		const bonusM = bonusMult(hole, dealerHole);
		const bonusPay = bonusM === 0 ? 0 : bonus * bonusM;

		mainWagered += mainStake;
		mainReturn += mainPay;
		totalWagered += mainStake + bonus;
		totalReturn += mainPay + bonusPay;
	}

	console.log(`Sims:            ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log(`Pre-flop fold:   ${((outcomes.fold / SIM_ROUNDS) * 100).toFixed(2)}%`);
	console.log(`Pre-flop play:   ${((outcomes.play / SIM_ROUNDS) * 100).toFixed(2)}%`);
	console.log(`Played → Win:    ${((outcomes.win / SIM_ROUNDS) * 100).toFixed(2)}%`);
	console.log(`Played → Loss:   ${((outcomes.loss / SIM_ROUNDS) * 100).toFixed(2)}%`);
	console.log(`Played → Tie:    ${((outcomes.tie / SIM_ROUNDS) * 100).toFixed(2)}%`);
	console.log('');
	console.log(`Main only (no bonus):`);
	console.log(`  Wagered:       ${mainWagered.toLocaleString('en-US')} units`);
	console.log(`  Returned:      ${mainReturn.toFixed(2)} units`);
	console.log(`  RTP:           ${((mainReturn / mainWagered) * 100).toFixed(4)}%`);
	console.log(`  House edge:    ${((1 - mainReturn / mainWagered) * 100).toFixed(4)}%`);
	console.log('');
	console.log(`Combined (main + bonus):`);
	console.log(`  Wagered:       ${totalWagered.toLocaleString('en-US')} units`);
	console.log(`  Returned:      ${totalReturn.toFixed(2)} units`);
	console.log(`  RTP:           ${((totalReturn / totalWagered) * 100).toFixed(4)}%`);
	console.log(`  House edge:    ${((1 - totalReturn / totalWagered) * 100).toFixed(4)}%`);
	console.log('');
	console.log(
		`House edge per Ante:  ${(((totalAnteWagered - totalReturn) / totalAnteWagered) * 100).toFixed(
			4
		)}%`
	);
	console.log(`Element of Risk:      ${((1 - totalReturn / totalWagered) * 100).toFixed(4)}%`);
	console.log('');
	console.log(`Target RTP per CoinPoker spec: 97.30%`);
}

console.log(
	"OvertimeBonusHoldem — pure-JS edge verification (Texas Hold'em Bonus / Casino Hold'em variant)"
);
console.log('');
runSim();
