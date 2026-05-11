/**
 * Standalone calibration helper: prints hypergeometric probabilities and computed RTP for each
 * Pick 1..10 paytable. Use to verify contract defaults yield 96.5–98% RTP within the 100x cap.
 *
 * Run: `node scripts/calibrateKenoPaytables.js`
 * (no Hardhat required; pure math)
 */

const POOL = 80;
const DRAW = 20;
const CAP = 100;

// Big-integer binomial (exact)
function choose(n, k) {
	if (k < 0 || k > n) return 0n;
	if (k > n - k) k = n - k;
	let r = 1n,
		num = BigInt(n),
		div = 1n;
	for (let i = 0; i < k; i++) {
		r = (r * (num - BigInt(i))) / div;
		div = BigInt(i + 1);
		// We accumulate numerator first to keep intermediate exact
	}
	// Use a more careful pass:
	r = 1n;
	for (let i = 0; i < k; i++) {
		r *= BigInt(n - i);
		r /= BigInt(i + 1);
	}
	return r;
}

function probHits(picks, hits) {
	const n = choose(picks, hits) * choose(POOL - picks, DRAW - hits);
	const d = choose(POOL, DRAW);
	return Number((n * 10n ** 18n) / d) / 1e18;
}

function rtp(picks, paytable) {
	let r = 0;
	for (let k = 0; k <= picks; k++) r += probHits(picks, k) * paytable[k];
	return r;
}

// Calibrated paytables (verified to clear ≥1.9% edge with 100x cap)
const PAYTABLES = {
	1: [0, 3.92],
	2: [0, 1, 10],
	3: [0, 0, 2, 50],
	4: [0, 0, 1, 12, 80],
	5: [0, 0, 1, 3, 33, 80],
	6: [0, 0, 1, 2, 8, 55, 100],
	7: [0, 0, 0, 2, 6, 27, 100, 100],
	8: [0, 0, 0, 1, 4, 18, 38, 100, 100],
	9: [0, 0, 0, 1, 3, 7, 20, 70, 100, 100],
	10: [0, 0, 0, 1, 2, 4, 11, 38, 100, 100, 100],
};

console.log('Keno paytable calibration (POOL=80, DRAW=20, CAP=100x)');
console.log('=========================================================');
for (const picks of Object.keys(PAYTABLES)
	.map(Number)
	.sort((a, b) => a - b)) {
	const pt = PAYTABLES[picks];
	const r = rtp(picks, pt);
	const edge = (1 - r) * 100;
	const overcapped = pt.some((m) => m > CAP);
	console.log(
		`Pick ${picks.toString().padStart(2)}: paytable [${pt.join(', ').padEnd(40)}] RTP=${(
			r * 100
		).toFixed(3)}% edge=${edge.toFixed(3)}%${overcapped ? ' ⚠ over cap!' : ''}`
	);
	// Also show the per-hit contributions
	for (let k = 0; k <= picks; k++) {
		const p = probHits(picks, k);
		const contrib = p * pt[k];
		if (contrib > 0.001 || pt[k] > 0) {
			console.log(
				`   hits=${k}: P=${p.toExponential(3)} × ${pt[k]}x = ${(contrib * 100).toFixed(3)}%`
			);
		}
	}
}
