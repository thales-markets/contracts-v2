/**
 * Three Card Poker edge verification — pure-JS Monte Carlo against the hardcoded paytable
 * constants in `ThreeCardPoker.sol`. 10M sims to give the rare classes (SF ≈ 0.22%, 3K ≈ 0.24%)
 * enough mass for tight convergence.
 *
 * Three independent wagers, all verified:
 *   1. Pair Plus      — paytable-driven, no decision   (analytic edge ≈ 2.32%)
 *   2. Ante Bonus     — bonus on top of Ante, no decision (EV per ante ≈ +5.29%)
 *   3. Ante + Play    — has a decision; tested under TWO strategies:
 *        - Q-6-4 optimal rule (industry standard)
 *        - Always Play (suboptimal but bounded)
 *
 * Reports both per-Ante house edge AND Element-of-Risk (per total dollar action incl. Play stake).
 * The 2% floor in [[casino-edge-floor]] is on element-of-risk.
 *
 * Paytables are hardcoded constants in the contract — there's no on-chain state to read.
 * Run: `node scripts/verifyThreeCardPokerEdge.js`
 */

const SIM_ROUNDS = 10_000_000;

// ---------------- Hand class constants (mirror ThreeCardPoker.sol) ----------------
const CLASS_HIGH_CARD = 0;
const CLASS_PAIR = 1;
const CLASS_FLUSH = 2;
const CLASS_STRAIGHT = 3;
const CLASS_THREE_OF_A_KIND = 4;
const CLASS_STRAIGHT_FLUSH = 5;

const RANK_TWO = 2;
const RANK_THREE = 3;
const RANK_QUEEN = 12;
const RANK_ACE = 14;
const QUALIFIER_RANK = RANK_QUEEN;

// Paytables (multipliers; net of stake — payout = stake * (mult + 1) on win)
const PP_MULT = {
	[CLASS_STRAIGHT_FLUSH]: 40,
	[CLASS_THREE_OF_A_KIND]: 30,
	[CLASS_STRAIGHT]: 6,
	[CLASS_FLUSH]: 4,
	[CLASS_PAIR]: 1,
};
const BONUS_MULT = {
	[CLASS_STRAIGHT_FLUSH]: 5,
	[CLASS_THREE_OF_A_KIND]: 4,
	[CLASS_STRAIGHT]: 1,
};

// ---------------- RNG ----------------
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

// ---------------- Deck / deal ----------------
// Reusable buffers to avoid GC churn at 10M iterations
const deck = new Uint8Array(52);
const hand = new Uint8Array(6);

function dealSixCards(rng) {
	for (let i = 0; i < 52; i++) deck[i] = i;
	// Partial Fisher-Yates: first 6 slots end up as 6 unique cards
	for (let i = 0; i < 6; i++) {
		const j = i + ((rng() * (52 - i)) | 0);
		const tmp = deck[i];
		deck[i] = deck[j];
		deck[j] = tmp;
	}
	hand[0] = deck[0];
	hand[1] = deck[1];
	hand[2] = deck[2];
	hand[3] = deck[3];
	hand[4] = deck[4];
	hand[5] = deck[5];
	return hand;
}

// ---------------- Hand evaluation (mirrors ThreeCardPoker.sol::_evaluate3Card) ----------------
function evaluate3Card(c0, c1, c2) {
	const r0 = (c0 % 13) + RANK_TWO;
	const r1 = (c1 % 13) + RANK_TWO;
	const r2 = (c2 % 13) + RANK_TWO;
	const s0 = (c0 / 13) | 0;
	const s1 = (c1 / 13) | 0;
	const s2 = (c2 / 13) | 0;

	// Sort descending
	let rHi, rMid, rLo;
	if (r0 >= r1) {
		if (r1 >= r2) {
			rHi = r0;
			rMid = r1;
			rLo = r2;
		} else if (r0 >= r2) {
			rHi = r0;
			rMid = r2;
			rLo = r1;
		} else {
			rHi = r2;
			rMid = r0;
			rLo = r1;
		}
	} else {
		if (r0 >= r2) {
			rHi = r1;
			rMid = r0;
			rLo = r2;
		} else if (r1 >= r2) {
			rHi = r1;
			rMid = r2;
			rLo = r0;
		} else {
			rHi = r2;
			rMid = r1;
			rLo = r0;
		}
	}

	const isFlush = s0 === s1 && s1 === s2;
	let isStraight = false;
	let straightTop = rHi;
	if (rHi - rLo === 2 && rHi - rMid === 1) {
		isStraight = true;
	} else if (rHi === RANK_ACE && rMid === RANK_THREE && rLo === RANK_TWO) {
		isStraight = true;
		straightTop = RANK_THREE;
	}

	// Three of a kind first (overrides straight/flush even if all-same-rank can't be both anyway)
	if (rHi === rLo) {
		return { cls: CLASS_THREE_OF_A_KIND, tie: rHi };
	}
	if (isStraight && isFlush) {
		return { cls: CLASS_STRAIGHT_FLUSH, tie: straightTop };
	}
	if (isStraight) {
		return { cls: CLASS_STRAIGHT, tie: straightTop };
	}
	if (isFlush) {
		return { cls: CLASS_FLUSH, tie: (rHi << 16) | (rMid << 8) | rLo };
	}
	if (rHi === rMid) {
		return { cls: CLASS_PAIR, tie: (rHi << 8) | rLo };
	}
	if (rMid === rLo) {
		return { cls: CLASS_PAIR, tie: (rMid << 8) | rHi };
	}
	return { cls: CLASS_HIGH_CARD, tie: (rHi << 16) | (rMid << 8) | rLo };
}

function compareHands(pCls, pTie, dCls, dTie) {
	if (pCls > dCls) return 1;
	if (pCls < dCls) return -1;
	if (pTie > dTie) return 1;
	if (pTie < dTie) return -1;
	return 0;
}

function dealerQualifies(dCls, c0, c1, c2) {
	if (dCls > CLASS_HIGH_CARD) return true;
	const r0 = (c0 % 13) + RANK_TWO;
	const r1 = (c1 % 13) + RANK_TWO;
	const r2 = (c2 % 13) + RANK_TWO;
	let top = r0;
	if (r1 > top) top = r1;
	if (r2 > top) top = r2;
	return top >= QUALIFIER_RANK;
}

// ---------------- Strategies ----------------
// Q-6-4: Play any pair-or-better; on high card, play iff hand ≥ Q-6-4
function shouldPlay_Q64(cls, c0, c1, c2) {
	if (cls >= CLASS_PAIR) return true;
	const r0 = (c0 % 13) + RANK_TWO;
	const r1 = (c1 % 13) + RANK_TWO;
	const r2 = (c2 % 13) + RANK_TWO;
	let hi = r0,
		mid = r1,
		lo = r2;
	if (mid > hi) {
		const t = hi;
		hi = mid;
		mid = t;
	}
	if (lo > hi) {
		const t = hi;
		hi = lo;
		lo = t;
	}
	if (lo > mid) {
		const t = mid;
		mid = lo;
		lo = t;
	}
	if (hi > RANK_QUEEN) return true;
	if (hi < RANK_QUEEN) return false;
	if (mid > 6) return true;
	if (mid < 6) return false;
	return lo >= 4;
}

// ---------------- Analytic baselines (combinatorial) ----------------
const C52_3 = 22100; // C(52,3)
const CLASS_COUNTS = {
	[CLASS_STRAIGHT_FLUSH]: 48,
	[CLASS_THREE_OF_A_KIND]: 52,
	[CLASS_STRAIGHT]: 720,
	[CLASS_FLUSH]: 1096,
	[CLASS_PAIR]: 3744,
	[CLASS_HIGH_CARD]: 16440,
};
// Sanity check
{
	const sum = Object.values(CLASS_COUNTS).reduce((a, b) => a + b, 0);
	if (sum !== C52_3) throw new Error(`class count sum ${sum} != ${C52_3}`);
}

function analyticPP_RTP() {
	// payout = stake × (mult + 1) on win; high card pays 0
	let acc = 0;
	for (const [clsStr, mult] of Object.entries(PP_MULT)) {
		const cls = Number(clsStr);
		acc += CLASS_COUNTS[cls] * (mult + 1);
	}
	return acc / C52_3;
}

function analyticBonusEV() {
	let acc = 0;
	for (const [clsStr, mult] of Object.entries(BONUS_MULT)) {
		const cls = Number(clsStr);
		acc += CLASS_COUNTS[cls] * mult;
	}
	return acc / C52_3;
}

// ---------------- Main sim ----------------
function fmtPct(n) {
	return `${(n * 100).toFixed(4)}%`;
}

function runSim(strategyName, strategyFn) {
	const rng = mulberry32(0xbadcafe + strategyName.length * 1009);

	let pp_stake = 0; // in unit of pp stake
	let pp_payout = 0;
	let ante_wagered = 0;
	let ante_returned = 0; // ante stake-back + ante 1:1 win + play stake-back + play 1:1 win + ante bonus
	let play_stake_wagered = 0; // for element-of-risk denominator
	let bonus_payout = 0;

	const classCounts = new Int32Array(6);
	let foldCount = 0;
	let dealerNotQualifies = 0;
	let playerWins = 0;
	let dealerWins = 0;
	let ties = 0;

	const ante = 1.0;
	const pp = 1.0; // separate unit

	for (let i = 0; i < SIM_ROUNDS; i++) {
		const cards = dealSixCards(rng);
		const p0 = cards[0],
			p1 = cards[1],
			p2 = cards[2];
		const d0 = cards[3],
			d1 = cards[4],
			d2 = cards[5];

		const pEval = evaluate3Card(p0, p1, p2);
		classCounts[pEval.cls]++;

		// --- Pair Plus ---
		pp_stake += pp;
		const ppMult = PP_MULT[pEval.cls];
		if (ppMult !== undefined) pp_payout += pp * (ppMult + 1);

		// --- Ante Bonus (independent of dealer/strategy; paid as long as Ante is in) ---
		const bonusMult = BONUS_MULT[pEval.cls];
		if (bonusMult !== undefined) bonus_payout += ante * bonusMult;

		// --- Ante + Play ---
		ante_wagered += ante;
		const play = strategyFn(pEval.cls, p0, p1, p2);
		if (!play) {
			foldCount++;
			// Ante lost; Ante Bonus already counted; total returned from ante side = bonus only
			continue;
		}
		play_stake_wagered += ante;

		const dEval = evaluate3Card(d0, d1, d2);
		const qualifies = dealerQualifies(dEval.cls, d0, d1, d2);

		if (!qualifies) {
			dealerNotQualifies++;
			// Ante 1:1, Play pushes (stake back). Returned: ante (stake) + ante (1:1 win) + ante (play push) = 3*ante
			ante_returned += 3 * ante;
		} else {
			const cmp = compareHands(pEval.cls, pEval.tie, dEval.cls, dEval.tie);
			if (cmp > 0) {
				playerWins++;
				// Ante 1:1 + Play 1:1 → returned 4*ante
				ante_returned += 4 * ante;
			} else if (cmp < 0) {
				dealerWins++;
				// Both lost; returned 0
			} else {
				ties++;
				// Both push; returned 2*ante
				ante_returned += 2 * ante;
			}
		}
	}

	// Ante side net = (ante_returned + bonus_payout) - (ante_wagered + play_stake_wagered)
	const ante_side_total_returned = ante_returned + bonus_payout;
	const ante_side_total_wagered = ante_wagered + play_stake_wagered;
	const ante_side_net = ante_side_total_returned - ante_side_total_wagered;
	const edge_per_ante = -ante_side_net / ante_wagered;
	const element_of_risk = -ante_side_net / ante_side_total_wagered;

	console.log(`==== Ante-side strategy: ${strategyName} ====`);
	console.log(`Hands:                ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log(`Fold rate:            ${fmtPct(foldCount / SIM_ROUNDS)}`);
	console.log(`Play rate:            ${fmtPct(1 - foldCount / SIM_ROUNDS)}`);
	console.log(
		`  Dealer NQ:          ${fmtPct(
			dealerNotQualifies / SIM_ROUNDS
		)} (player wins ante 1:1, play pushes)`
	);
	console.log(`  Player win:         ${fmtPct(playerWins / SIM_ROUNDS)} (both 1:1)`);
	console.log(`  Dealer win:         ${fmtPct(dealerWins / SIM_ROUNDS)} (both lose)`);
	console.log(`  Tie:                ${fmtPct(ties / SIM_ROUNDS)} (both push)`);
	console.log(`Ante wagered:         ${ante_wagered.toFixed(0)} units`);
	console.log(`Play stake wagered:   ${play_stake_wagered.toFixed(0)} units`);
	console.log(`Ante-side returned:   ${ante_side_total_returned.toFixed(2)} units`);
	console.log(`Ante-side net:        ${ante_side_net.toFixed(2)} units (negative = house wins)`);
	console.log(
		`Bonus contribution:   +${((bonus_payout / ante_wagered) * 100).toFixed(4)}% per ante`
	);
	console.log(`House edge per Ante:  ${(edge_per_ante * 100).toFixed(4)}%`);
	console.log(
		`Element of Risk:      ${(element_of_risk * 100).toFixed(4)}%  (per total $ wagered incl. Play)`
	);
	console.log('');

	return { edge_per_ante, element_of_risk, foldRate: foldCount / SIM_ROUNDS, classCounts };
}

function runPP() {
	const rng = mulberry32(0xfeedface);
	let stake = 0;
	let payout = 0;
	const classCounts = new Int32Array(6);
	let maxMult = 0;

	for (let i = 0; i < SIM_ROUNDS; i++) {
		const cards = dealSixCards(rng);
		const e = evaluate3Card(cards[0], cards[1], cards[2]);
		classCounts[e.cls]++;
		stake += 1;
		const mult = PP_MULT[e.cls];
		if (mult !== undefined) {
			payout += 1 + mult;
			if (mult > maxMult) maxMult = mult;
		}
	}

	const rtp = payout / stake;
	const edge = 1 - rtp;

	console.log('==== Pair Plus ====');
	console.log(`Hands:                ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log(`Max mult hit:         ${maxMult}x`);
	console.log(`Hand class distribution (realized vs expected):`);
	const CLASS_NAMES = ['HIGH', 'PAIR', 'FLUSH', 'STR', '3K', 'SF'];
	for (let cls = 5; cls >= 0; cls--) {
		const real = classCounts[cls] / SIM_ROUNDS;
		const exp = CLASS_COUNTS[cls] / C52_3;
		const tag = PP_MULT[cls] !== undefined ? `${PP_MULT[cls]}:1` : '—';
		console.log(
			`   ${CLASS_NAMES[cls].padEnd(5)}  ${tag.padEnd(5)}  ${classCounts[cls]
				.toString()
				.padStart(9)}    ${(real * 100).toFixed(4).padStart(8)}%    ${(exp * 100)
				.toFixed(4)
				.padStart(8)}%`
		);
	}
	console.log(
		`Realized RTP:         ${(rtp * 100).toFixed(4)}%   (edge ${(edge * 100).toFixed(4)}%)`
	);
	const analytic = analyticPP_RTP();
	console.log(
		`Analytic RTP:         ${(analytic * 100).toFixed(4)}%   (edge ${((1 - analytic) * 100).toFixed(
			4
		)}%)`
	);
	console.log('');

	return { rtp, edge, analytic };
}

function main() {
	console.log(`Three Card Poker — pure-JS edge verification`);
	console.log(`Sims per scenario:    ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log(`Source paytables:     ThreeCardPoker.sol constants L67-77`);
	console.log('');

	console.log(`Analytic baselines:`);
	const pp = analyticPP_RTP();
	const bonus = analyticBonusEV();
	console.log(`  Pair Plus RTP:        ${fmtPct(pp)}  (edge ${fmtPct(1 - pp)})`);
	console.log(`  Ante Bonus EV/ante:   +${fmtPct(bonus)}`);
	console.log(`  Published Q-6-4 edge: ~3.37% per ante / ~2.02% element-of-risk`);
	console.log(`  Published always-play edge: ~3.83% per ante / ~2.30% element-of-risk`);
	console.log('');

	const ppResult = runPP();
	const q64 = runSim('Q-6-4 optimal', shouldPlay_Q64);
	const alwaysPlay = runSim('Always Play', () => true);
	const alwaysFold = runSim('Always Fold', () => false);

	const FLOOR = 0.02;
	console.log('========== SUMMARY ==========');
	console.log('wager                   realized      analytic/published   pass≥2% EoR?');
	console.log(
		`Pair Plus               edge ${(ppResult.edge * 100).toFixed(4)}%    ${(
			(1 - ppResult.analytic) *
			100
		).toFixed(4)}% analytic    ${ppResult.edge >= FLOOR ? 'PASS' : '** FAIL **'}`
	);
	console.log(
		`Ante side (Q-6-4)       EoR  ${(q64.element_of_risk * 100).toFixed(
			4
		)}%    ~2.02% published    ${q64.element_of_risk >= FLOOR ? 'PASS' : '** FAIL **'}`
	);
	console.log(
		`Ante side (always-play) EoR  ${(alwaysPlay.element_of_risk * 100).toFixed(
			4
		)}%    ~2.30% published    ${alwaysPlay.element_of_risk >= FLOOR ? 'PASS' : '** FAIL **'}`
	);
	console.log(
		`Ante side (always-fold) EoR  ${(alwaysFold.element_of_risk * 100).toFixed(
			4
		)}%    bonus-only          informational`
	);
	console.log('');

	const fails = [];
	if (ppResult.edge < FLOOR) fails.push(`Pair Plus (${(ppResult.edge * 100).toFixed(4)}%)`);
	if (q64.element_of_risk < FLOOR)
		fails.push(`Q-6-4 EoR (${(q64.element_of_risk * 100).toFixed(4)}%)`);
	// Always-play and always-fold are informational; only Q-6-4 (optimal player) defines the floor.

	if (fails.length > 0) {
		console.log(`FAIL: ${fails.join(', ')}`);
		process.exitCode = 1;
	} else {
		console.log(
			`PASS: Pair Plus + Q-6-4 optimal strategy both clear the 2% element-of-risk floor.`
		);
	}
}

main();
