/**
 * Quick sanity check: compute analytic RTP for VideoPoker under "no-draw" strategy (hold all 5,
 * just evaluate the initial deal). Uses exact 5-card-hand frequencies from C(52,5) = 2,598,960.
 *
 * Paytable per VideoPoker.sol:63-71 (multipliers; payout = stake × (mult + 1) on win):
 *   Royal Flush     500
 *   Straight Flush   50
 *   Four of a Kind   25
 *   Full House        8
 *   Flush             5
 *   Straight          4
 *   Three of a Kind   3
 *   Two Pair          2
 *   Jacks or Better   1
 *
 * Standard 8/5 JoB pays JoB pair as "1 for 1" (push, just stake-back). This contract pays it
 * as "1 to 1" (1× stake-back + 1× profit). That delta on the most frequent winning hand
 * dramatically affects RTP. This script quantifies it.
 */

// Exact initial-deal hand frequencies (5-card draw, before any draws)
// Total: C(52,5) = 2,598,960
const TOTAL_HANDS = 2598960;
const FREQ = {
	royal: 4,
	straightFlush: 36,
	fourOfKind: 624,
	fullHouse: 3744,
	flush: 5108,
	straight: 10200,
	threeOfKind: 54912,
	twoPair: 123552,
	pair: 1098240, // all pairs (any rank)
	highCard: 1302540,
};

// JoB cut-off: 4 of 13 ranks count (J, Q, K, A)
const PAIR_JOB = (FREQ.pair * 4) / 13;
const PAIR_LOW = (FREQ.pair * 9) / 13;

// Contract paytable (multiplier; payout in stake units = (mult + 1) on win)
const MULT = {
	royal: 500,
	straightFlush: 50,
	fourOfKind: 25,
	fullHouse: 8,
	flush: 5,
	straight: 4,
	threeOfKind: 3,
	twoPair: 2,
	pairJoB: 1,
	pairLow: 0,
	highCard: 0,
};

// Standard 8/5 1-coin Royal=250, JoB pair=1 (push, no stake-back add)
const STD85_FOR_1 = {
	royal: 250,
	straightFlush: 50,
	fourOfKind: 25,
	fullHouse: 8,
	flush: 5,
	straight: 4,
	threeOfKind: 3,
	twoPair: 2,
	pairJoB: 1, // push
	pairLow: 0,
	highCard: 0,
};

function computeRTP(freqMap, paytable, addStakeBack) {
	let totalReturn = 0;
	for (const [cls, freq] of Object.entries(freqMap)) {
		const mult = paytable[cls];
		if (mult === undefined) continue;
		const perWin = addStakeBack ? (mult > 0 ? mult + 1 : 0) : mult;
		totalReturn += freq * perWin;
	}
	return totalReturn / TOTAL_HANDS;
}

const noDrawFreqs = {
	royal: FREQ.royal,
	straightFlush: FREQ.straightFlush,
	fourOfKind: FREQ.fourOfKind,
	fullHouse: FREQ.fullHouse,
	flush: FREQ.flush,
	straight: FREQ.straight,
	threeOfKind: FREQ.threeOfKind,
	twoPair: FREQ.twoPair,
	pairJoB: PAIR_JOB,
	pairLow: PAIR_LOW,
	highCard: FREQ.highCard,
};

const contractRTP_noDraw = computeRTP(noDrawFreqs, MULT, true);
const std85_1coin_noDraw = computeRTP(noDrawFreqs, STD85_FOR_1, false);

console.log('No-draw RTP comparison (hold all 5, evaluate initial deal):');
console.log('');
console.log(`  Contract (with stake-back):      ${(contractRTP_noDraw * 100).toFixed(4)}%`);
console.log(`  Standard 8/5 1-coin (Royal=250): ${(std85_1coin_noDraw * 100).toFixed(4)}%`);
console.log(
	`  Delta:                            ${((contractRTP_noDraw - std85_1coin_noDraw) * 100).toFixed(
		4
	)}pp`
);
console.log('');

// Per-class contributions to contract no-draw RTP
console.log('Contract no-draw RTP breakdown:');
let acc = 0;
for (const [cls, freq] of Object.entries(noDrawFreqs)) {
	const mult = MULT[cls];
	const perWin = mult > 0 ? mult + 1 : 0;
	const contrib = (freq * perWin) / TOTAL_HANDS;
	acc += contrib;
	console.log(
		`  ${cls.padEnd(15)}  P=${((freq / TOTAL_HANDS) * 100).toFixed(4).padStart(8)}%  payout=${perWin
			.toString()
			.padStart(4)}x  contributes ${(contrib * 100).toFixed(4)}pp`
	);
}
console.log(`  total: ${(acc * 100).toFixed(4)}%`);
console.log('');

// Under optimal play (8/5 JoB), the published hand frequencies are:
const OPTIMAL_85_FREQS = {
	royal: 0.0000248,
	straightFlush: 0.0001094,
	fourOfKind: 0.0023627,
	fullHouse: 0.0115124,
	flush: 0.0109827,
	straight: 0.0112291,
	threeOfKind: 0.0744494,
	twoPair: 0.1292791,
	pairJoB: 0.2145845,
	pairLow: 0,
	highCard: 0.5454659,
};

let contractRTP_opt = 0;
let std85_RTP_opt = 0;
for (const [cls, p] of Object.entries(OPTIMAL_85_FREQS)) {
	const mC = MULT[cls];
	const mS = STD85_FOR_1[cls];
	if (mC > 0) contractRTP_opt += p * (mC + 1);
	if (mS > 0) std85_RTP_opt += p * mS;
}

console.log('Optimal-play RTP (using published 8/5 hand frequencies):');
console.log(`  Contract (with stake-back, Royal=500):  ${(contractRTP_opt * 100).toFixed(4)}%`);
console.log(`  Standard 8/5 1-coin (Royal=250):        ${(std85_RTP_opt * 100).toFixed(4)}%`);
console.log(
	`  Delta:                                   ${((contractRTP_opt - std85_RTP_opt) * 100).toFixed(
		4
	)}pp`
);
console.log('');

if (contractRTP_opt > 1) {
	console.log(
		`!! CONTRACT RTP UNDER OPTIMAL PLAY = ${(contractRTP_opt * 100).toFixed(
			2
		)}%  →  PLAYER edge of ${((contractRTP_opt - 1) * 100).toFixed(2)}%`
	);
	console.log(
		`   The house loses ${((contractRTP_opt - 1) * 100).toFixed(2)}% per bet on average.`
	);
}
