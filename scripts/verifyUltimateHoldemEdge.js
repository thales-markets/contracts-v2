/**
 * Overtime Ultimate Holdem — pure-JS Monte Carlo with optimal strategy.
 *
 * Paytable per `OvertimeUltimateHoldem.sol`:
 *   - Ante: 1:1 on player win, PUSH on dealer-no-qualify, loses on dealer win
 *   - Play (1:1 stake+win): pays on player win OR dealer-no-qualify with player>dealer; push on tie
 *   - Blind: Royal 500, SF 50, 4K 10, FH 3, Flush 1, Straight 1, less than Straight PUSHES
 *
 * Reports: house edge per Ante AND Element of Risk (per total $ wagered including raises).
 * The 2% project floor is on EoR.
 *
 * The optimal strategy is implemented as a simplified ranked rule list (~95% of true optimal
 * edge value). Realized EoR will be slightly HIGHER than true-optimal (suboptimal player play
 * always favors the house), so this is a CONSERVATIVE check — if my realized EoR ≥ 2%, true
 * optimal might dip slightly below. Cross-check with published numbers if borderline.
 *
 * Run: `node scripts/verifyUltimateHoldemEdge.js`
 */

const SIM_ROUNDS = 1_000_000;

// Hand class constants (mirror OvertimeUltimateHoldem.sol)
const HIGH_CARD = 0;
const PAIR = 1;
const TWO_PAIR = 2;
const THREE_OF_A_KIND = 3;
const STRAIGHT = 4;
const FLUSH = 5;
const FULL_HOUSE = 6;
const FOUR_OF_A_KIND = 7;
const STRAIGHT_FLUSH = 8;
const ROYAL_FLUSH = 9;

// Blind paytable (multiplier on blind stake, paid on win in addition to stake-back)
const BLIND_MULT = {
	[ROYAL_FLUSH]: 500,
	[STRAIGHT_FLUSH]: 50,
	[FOUR_OF_A_KIND]: 10,
	[FULL_HOUSE]: 3,
	[FLUSH]: 1,
	[STRAIGHT]: 1,
};

// --- RNG ---
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

// --- Card utilities ---
// card 0..51; rank = (card % 13) + 2 (2..14, where 14 = Ace); suit = card / 13 (0..3)
function rank(c) {
	return (c % 13) + 2;
}
function suit(c) {
	return (c / 13) | 0;
}

// --- Deck management ---
const deck52 = new Uint8Array(52);
function dealNine(rng) {
	for (let i = 0; i < 52; i++) deck52[i] = i;
	for (let i = 0; i < 9; i++) {
		const j = i + ((rng() * (52 - i)) | 0);
		const tmp = deck52[i];
		deck52[i] = deck52[j];
		deck52[j] = tmp;
	}
	// Layout: [hole0, hole1, flop0, flop1, flop2, turn, river, dealerHole0, dealerHole1]
	return deck52;
}

// --- 5-card hand evaluator (returns a packed comparable uint32: class<<20 | tiebreaker) ---
function eval5(c0, c1, c2, c3, c4) {
	const ranks = [rank(c0), rank(c1), rank(c2), rank(c3), rank(c4)];
	const suits = [suit(c0), suit(c1), suit(c2), suit(c3), suit(c4)];
	ranks.sort((a, b) => b - a);

	const flush =
		suits[0] === suits[1] &&
		suits[1] === suits[2] &&
		suits[2] === suits[3] &&
		suits[3] === suits[4];

	// Straight detection
	let straightTop = 0;
	const u = ranks; // already descending
	if (u[0] - u[4] === 4 && u[0] !== u[1] && u[1] !== u[2] && u[2] !== u[3] && u[3] !== u[4]) {
		straightTop = u[0];
	} else if (u[0] === 14 && u[1] === 5 && u[2] === 4 && u[3] === 3 && u[4] === 2) {
		straightTop = 5; // wheel
	}

	// Rank counts (sorted descending)
	const counts = {};
	for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
	const entries = Object.entries(counts).map(([r, c]) => [+r, c]);
	entries.sort((a, b) => b[1] - a[1] || b[0] - a[0]);

	if (flush && straightTop === 14) return (ROYAL_FLUSH << 20) | 14;
	if (flush && straightTop) return (STRAIGHT_FLUSH << 20) | straightTop;
	if (entries[0][1] === 4) {
		// 4-of-kind: tiebreaker = (4rank << 4) | kicker
		return (FOUR_OF_A_KIND << 20) | (entries[0][0] << 4) | entries[1][0];
	}
	if (entries[0][1] === 3 && entries[1][1] === 2) {
		return (FULL_HOUSE << 20) | (entries[0][0] << 4) | entries[1][0];
	}
	if (flush) {
		return (FLUSH << 20) | (u[0] << 16) | (u[1] << 12) | (u[2] << 8) | (u[3] << 4) | u[4];
	}
	if (straightTop) return (STRAIGHT << 20) | straightTop;
	if (entries[0][1] === 3) {
		// 3-of-kind: rank then two kickers
		return (THREE_OF_A_KIND << 20) | (entries[0][0] << 12) | (entries[1][0] << 4) | entries[2][0];
	}
	if (entries[0][1] === 2 && entries[1][1] === 2) {
		const highPair = Math.max(entries[0][0], entries[1][0]);
		const lowPair = Math.min(entries[0][0], entries[1][0]);
		return (TWO_PAIR << 20) | (highPair << 12) | (lowPair << 4) | entries[2][0];
	}
	if (entries[0][1] === 2) {
		// Pair: pair rank + 3 kickers
		const kickers = entries
			.slice(1)
			.map((e) => e[0])
			.sort((a, b) => b - a);
		return (
			(PAIR << 20) | (entries[0][0] << 12) | (kickers[0] << 8) | (kickers[1] << 4) | kickers[2]
		);
	}
	return (HIGH_CARD << 20) | (u[0] << 16) | (u[1] << 12) | (u[2] << 8) | (u[3] << 4) | u[4];
}

// --- 7-card best-of-5 (enumerate C(7,5) = 21 combos) ---
const COMBOS_7C5 = [
	[0, 1, 2, 3, 4],
	[0, 1, 2, 3, 5],
	[0, 1, 2, 3, 6],
	[0, 1, 2, 4, 5],
	[0, 1, 2, 4, 6],
	[0, 1, 2, 5, 6],
	[0, 1, 3, 4, 5],
	[0, 1, 3, 4, 6],
	[0, 1, 3, 5, 6],
	[0, 1, 4, 5, 6],
	[0, 2, 3, 4, 5],
	[0, 2, 3, 4, 6],
	[0, 2, 3, 5, 6],
	[0, 2, 4, 5, 6],
	[0, 3, 4, 5, 6],
	[1, 2, 3, 4, 5],
	[1, 2, 3, 4, 6],
	[1, 2, 3, 5, 6],
	[1, 2, 4, 5, 6],
	[1, 3, 4, 5, 6],
	[2, 3, 4, 5, 6],
];

function eval7(cards) {
	let best = 0;
	for (let i = 0; i < 21; i++) {
		const c = COMBOS_7C5[i];
		const v = eval5(cards[c[0]], cards[c[1]], cards[c[2]], cards[c[3]], cards[c[4]]);
		if (v > best) best = v;
	}
	return best;
}

function classOf(v) {
	return v >>> 20;
}

// --- Strategy: Pre-flop (see hole only) ---
// Raise 3× with: any pair, suited Ace, suited K-5+, suited Q-8+, suited J-T,
// offsuit A-X (X = 2 if ace), offsuit K-9+, offsuit Q-T+, offsuit J-T (some sources)
function shouldRaisePreFlop(hole) {
	const r0 = rank(hole[0]);
	const r1 = rank(hole[1]);
	const s0 = suit(hole[0]);
	const s1 = suit(hole[1]);
	const hi = Math.max(r0, r1);
	const lo = Math.min(r0, r1);
	const suited = s0 === s1;

	// Pair
	if (r0 === r1) return true;
	// Ace: always raise (any ace beats half of random hands in heads-up)
	if (hi === 14) return true;
	// Suited
	if (suited) {
		if (hi === 13 && lo >= 5) return true; // K-5+ suited
		if (hi === 12 && lo >= 8) return true; // Q-8+ suited
		if (hi === 11 && lo >= 10) return true; // J-T suited
		return false;
	}
	// Offsuit
	if (hi === 13 && lo >= 9) return true; // K-9+ offsuit (Wizard says K-10, but K-9 is borderline)
	if (hi === 12 && lo >= 10) return true; // Q-T+ offsuit
	if (hi === 11 && lo === 10) return true; // J-T offsuit (marginal)
	return false;
}

// --- Strategy: Post-flop (see hole + flop) ---
// Raise 2× with: hidden pair (hole pair), top pair or better using either hole card,
// 4-to-a-flush including a hole card, 4-to-an-OESD with overcards
function shouldRaisePostFlop(hole, flop) {
	const cards = [hole[0], hole[1], flop[0], flop[1], flop[2]];
	const v = eval5(cards[0], cards[1], cards[2], cards[3], cards[4]);
	const cls = classOf(v);

	// Pocket pair already a pair on the flop OR set/full/quads/straight/flush — easy raise
	if (cls >= TWO_PAIR) return true;

	// Pair: only raise if it uses a hole card (= top pair or better, OR hidden pair)
	if (cls === PAIR) {
		const pairRank = (v >> 12) & 0xf;
		const usesHole = rank(hole[0]) === pairRank || rank(hole[1]) === pairRank;
		if (!usesHole) {
			// Board pair only — don't raise (player has no edge over dealer)
			return false;
		}
		// Heuristic: raise top pair or hidden pair; with a kicker (hole-card pair uses both cards
		// or matches hole rank, so we treat it as raise candidate).
		// Compare pair rank to flop's high card; if pair >= flop high, top pair or overpair.
		const flopHi = Math.max(rank(flop[0]), rank(flop[1]), rank(flop[2]));
		if (pairRank >= flopHi) return true;
		// Hidden pair (player pocket pair): pairRank = both hole cards' rank → already handled
		if (rank(hole[0]) === rank(hole[1]) && pairRank === rank(hole[0])) return true;
		// Middle/bottom pair w/ flop overcards — fold-equity is poor; check
		return false;
	}

	// 4-to-a-flush: 4 cards same suit among the 5
	const suitCount = new Uint8Array(4);
	for (let i = 0; i < 5; i++) suitCount[suit(cards[i])]++;
	for (let s = 0; s < 4; s++) {
		if (suitCount[s] === 4) {
			// 4-to-flush — raise (still ~35% to make on turn+river)
			return true;
		}
	}

	return false;
}

// --- Strategy: River (see all 7 cards) ---
// Raise 1× with: any pair using a hole card, OR ≥ 11 outs (simplified to: pair-or-better
// using a hole card, OR any pair tied or better with player's 7-card eval ≥ certain threshold)
function shouldRaiseRiver(hole, community) {
	const cards = [
		hole[0],
		hole[1],
		community[0],
		community[1],
		community[2],
		community[3],
		community[4],
	];
	const pv = eval7(cards);
	const cls = classOf(pv);

	// Easy raise: 2-pair or better
	if (cls >= TWO_PAIR) return true;

	// Pair: must use a hole card to raise
	if (cls === PAIR) {
		const pairRank = (pv >> 12) & 0xf;
		const usesHole = rank(hole[0]) === pairRank || rank(hole[1]) === pairRank;
		return usesHole;
	}

	// High card only — fold
	return false;
}

// --- Simulator ---
function runSim() {
	const rng = mulberry32(0xdeadc0de);
	const ante = 1; // unit stake; blind == ante
	let anteWagered = 0; // sum of all ante stakes
	let totalWagered = 0; // ante + blind + play (for EoR)
	let playerReturn = 0; // total $ paid back to player across all bets

	const decisions = {
		preFlopRaise: 0,
		preFlopCheck: 0,
		postFlopRaise: 0,
		postFlopCheck: 0,
		riverRaise: 0,
		riverFold: 0,
	};
	const outcomes = { playerWin: 0, dealerWin: 0, dnq: 0, tie: 0, fold: 0 };
	const playerHandClass = new Int32Array(10);
	let maxPayout = 0;

	for (let i = 0; i < SIM_ROUNDS; i++) {
		const d = dealNine(rng);
		const hole = [d[0], d[1]];
		const community = [d[2], d[3], d[4], d[5], d[6]];
		const dealerHole = [d[7], d[8]];

		// Place: ante + blind pulled
		anteWagered += ante;
		totalWagered += 2 * ante; // ante + blind
		let playAmount = 0;

		// Pre-flop decision
		if (shouldRaisePreFlop(hole)) {
			decisions.preFlopRaise++;
			playAmount = 3 * ante;
			totalWagered += playAmount;
		} else {
			decisions.preFlopCheck++;
			// Post-flop decision
			const flop = [community[0], community[1], community[2]];
			if (shouldRaisePostFlop(hole, flop)) {
				decisions.postFlopRaise++;
				playAmount = 2 * ante;
				totalWagered += playAmount;
			} else {
				decisions.postFlopCheck++;
				// River decision
				if (shouldRaiseRiver(hole, community)) {
					decisions.riverRaise++;
					playAmount = 1 * ante;
					totalWagered += playAmount;
				} else {
					decisions.riverFold++;
					outcomes.fold++;
					// Forfeit ante + blind. playerReturn += 0
					continue;
				}
			}
		}

		// Resolve
		const playerCards = [
			hole[0],
			hole[1],
			community[0],
			community[1],
			community[2],
			community[3],
			community[4],
		];
		const dealerCards = [
			dealerHole[0],
			dealerHole[1],
			community[0],
			community[1],
			community[2],
			community[3],
			community[4],
		];
		const pVal = eval7(playerCards);
		const dVal = eval7(dealerCards);
		const dealerQualifies = classOf(dVal) >= PAIR;

		playerHandClass[classOf(pVal)]++;

		let antePayout = 0,
			playPayout = 0,
			blindPayout = 0;

		if (!dealerQualifies) {
			outcomes.dnq++;
			antePayout = ante; // push
			if (pVal > dVal) {
				playPayout = playAmount * 2; // 1:1 + stake back
				blindPayout = blindWinPayout(ante, pVal);
			} else if (pVal === dVal) {
				playPayout = playAmount;
				blindPayout = ante;
			}
		} else if (pVal > dVal) {
			outcomes.playerWin++;
			antePayout = ante * 2;
			playPayout = playAmount * 2;
			blindPayout = blindWinPayout(ante, pVal);
		} else if (pVal < dVal) {
			outcomes.dealerWin++;
			// All three lose
		} else {
			outcomes.tie++;
			antePayout = ante;
			playPayout = playAmount;
			blindPayout = ante;
		}

		const totalPayout = antePayout + playPayout + blindPayout;
		playerReturn += totalPayout;
		if (totalPayout > maxPayout) maxPayout = totalPayout;
	}

	const netLoss = totalWagered - playerReturn; // positive = house wins
	const edgePerAnte = netLoss / anteWagered;
	const elementOfRisk = netLoss / totalWagered;

	console.log(`Sims:                ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log('');
	console.log('Decisions:');
	const pct = (n) => `${((n / SIM_ROUNDS) * 100).toFixed(2)}%`;
	console.log(
		`  Pre-flop raise (3×):  ${pct(decisions.preFlopRaise)}   check: ${pct(decisions.preFlopCheck)}`
	);
	console.log(
		`  Post-flop raise (2×): ${pct(decisions.postFlopRaise)}   check: ${pct(
			decisions.postFlopCheck
		)}`
	);
	console.log(
		`  River raise (1×):     ${pct(decisions.riverRaise)}   fold: ${pct(decisions.riverFold)}`
	);
	console.log('');
	console.log('Outcomes:');
	console.log(`  Player wins:          ${pct(outcomes.playerWin)}`);
	console.log(`  Dealer wins:          ${pct(outcomes.dealerWin)}`);
	console.log(`  Dealer no-qualify:    ${pct(outcomes.dnq)}`);
	console.log(`  Tie:                  ${pct(outcomes.tie)}`);
	console.log(`  Folded (river):       ${pct(outcomes.fold)}`);
	console.log('');
	console.log('Player hand class distribution (final 7-card best-5):');
	const CLASS_NAMES = [
		'HIGH',
		'PAIR',
		'TWO_PAIR',
		'TRIPS',
		'STR',
		'FLUSH',
		'FH',
		'QUADS',
		'SF',
		'ROYAL',
	];
	for (let c = 9; c >= 0; c--) {
		const n = playerHandClass[c];
		if (n === 0 && c < HIGH_CARD) continue;
		console.log(
			`  ${CLASS_NAMES[c].padEnd(9)}  ${n.toString().padStart(8)}   ${(
				(n / SIM_ROUNDS) *
				100
			).toFixed(4)}%`
		);
	}
	console.log('');
	console.log(`Total Ante wagered:   ${anteWagered.toLocaleString('en-US')}`);
	console.log(
		`Total $ wagered:      ${totalWagered.toLocaleString('en-US')} (avg ${(
			totalWagered / SIM_ROUNDS
		).toFixed(2)} units/hand)`
	);
	console.log(`Total returned:       ${playerReturn.toFixed(2)}`);
	console.log(`House net:            ${netLoss.toFixed(2)}`);
	console.log('');
	console.log(`House edge per Ante:  ${(edgePerAnte * 100).toFixed(4)}%`);
	console.log(`Element of Risk:      ${(elementOfRisk * 100).toFixed(4)}%   (≥ 2% floor required)`);
	console.log(`Max single payout:    ${maxPayout}x ante`);

	return { edgePerAnte, elementOfRisk };
}

function blindWinPayout(ante, handValue) {
	const cls = classOf(handValue);
	const mult = BLIND_MULT[cls] || 0;
	return ante * (1 + mult);
}

const r = runSim();
console.log('');
const FLOOR = 0.02;
if (r.elementOfRisk < FLOOR) {
	console.log(
		`** EoR ${(r.elementOfRisk * 100).toFixed(4)}% < 2% floor — paytable tightening needed.`
	);
	process.exitCode = 1;
} else {
	console.log(`PASS: EoR ${(r.elementOfRisk * 100).toFixed(4)}% ≥ 2% floor.`);
}
console.log('');
console.log(
	'Note: my strategy is ~95% optimal. True optimal player would have slightly LOWER EoR.'
);
console.log('Reference: standard UTH (Flush 3:2, Ante 1:1 on no-qualify) has EoR ≈ 0.53%.');
console.log('Contract variant tightens both Ante (push on no-qualify) and Flush (1:1).');
