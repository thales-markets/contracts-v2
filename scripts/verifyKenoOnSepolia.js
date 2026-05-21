/**
 * Keno on-chain edge verification — reads the deployed Pick 1..10 paytables from the live Keno
 * proxy on optimisticSepolia and runs 1M pure-JS Monte Carlo sims per pick count using exact
 * hypergeometric sampling. Reports analytic RTP, realized RTP, edge, hit distribution.
 *
 * Math note: the contract's draw is partial Fisher-Yates over [1..80] yielding 20 unique
 * numbers; for a given player pick count N the hit-count `k` is hypergeometric(80, N, 20).
 * Marginal hit distribution does not depend on WHICH numbers the player picked, only the count.
 * So we sample k ∈ [0..N] directly from the exact CDF — faster than re-simulating the draw
 * and statistically identical.
 *
 * Asserts edge ≥ 2% per pick count (project-wide casino_edge_floor policy). Pick 2 is known to
 * be at 1.899% on the V2 default paytable — this script will flag it.
 *
 * Run: `npx hardhat run scripts/verifyKenoOnSepolia.js --network optimisticSepolia`
 */

const { ethers } = require('hardhat');
const deployments = require('./deployments.json');

const SIM_ROUNDS = 1_000_000;
const POOL = 80n;
const DRAW = 20n;
const MIN_PICKS = 1;
const MAX_PICKS = 10;
const EDGE_FLOOR_PCT = 2.0;

function chooseBig(n, k) {
	if (k < 0n || k > n) return 0n;
	if (k > n - k) k = n - k;
	let r = 1n;
	for (let i = 0n; i < k; i++) {
		r = (r * (n - i)) / (i + 1n);
	}
	return r;
}

// P(k hits | picks=N) = C(N,k) * C(80-N, 20-k) / C(80, 20)
function hypergeomProb(N, k) {
	const Nb = BigInt(N);
	const kb = BigInt(k);
	const num = chooseBig(Nb, kb) * chooseBig(POOL - Nb, DRAW - kb);
	const den = chooseBig(POOL, DRAW);
	return Number((num * 10n ** 18n) / den) / 1e18;
}

// Exact analytic RTP in 1e18 BigInt precision: sum_k (C(N,k)*C(80-N,20-k) * paytable[k]) / C(80,20)
function analyticRtpE18(picksCount, paytableE18) {
	const N = BigInt(picksCount);
	const den = chooseBig(POOL, DRAW);
	let num = 0n;
	for (let k = 0; k <= picksCount; k++) {
		const kb = BigInt(k);
		const p = chooseBig(N, kb) * chooseBig(POOL - N, DRAW - kb);
		num += p * paytableE18[k];
	}
	return num / den;
}

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

function fmtMult(e18) {
	const n = Number(e18) / 1e18;
	return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
}

async function main() {
	const network = await ethers.provider.getNetwork();
	const chainId = Number(network.chainId);
	if (chainId !== 11155420) {
		throw new Error(`Expected optimisticSepolia (11155420), got chainId ${chainId}`);
	}

	const kenoAddr = deployments.optimisticSepolia.Keno;
	if (!kenoAddr) throw new Error('Keno address not in deployments.json for optimisticSepolia');

	const keno = await ethers.getContractAt('Keno', kenoAddr);
	console.log(`Keno proxy:      ${kenoAddr}`);
	console.log(`Chain:           optimisticSepolia (${chainId})`);
	console.log(`Sims per pick:   ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log('');

	const results = [];

	for (let N = MIN_PICKS; N <= MAX_PICKS; N++) {
		const ptRaw = await keno.getPaytable(N);
		const pt = ptRaw.map((v) => BigInt(v));
		if (pt.length !== N + 1) {
			throw new Error(`Pick ${N}: paytable length ${pt.length}, expected ${N + 1}`);
		}

		// Analytic
		const analyticE18 = analyticRtpE18(N, pt);
		const analyticPct = Number(analyticE18) / 1e16;

		// Build hit distribution CDF for sampling
		const probs = new Float64Array(N + 1);
		const cdf = new Float64Array(N + 1);
		let cum = 0;
		for (let k = 0; k <= N; k++) {
			probs[k] = hypergeomProb(N, k);
			cum += probs[k];
			cdf[k] = cum;
		}
		// Renormalize to handle floating-point drift
		for (let k = 0; k <= N; k++) cdf[k] /= cum;

		// Monte Carlo
		const rng = mulberry32(0xdeadbeef + N * 1009);
		const hitCounts = new Array(N + 1).fill(0);
		const stakeE18 = 10n ** 18n;
		let totalStakeE18 = 0n;
		let totalPayoutE18 = 0n;
		let maxMultE18 = 0n;
		let hits = 0;
		let profits = 0;

		for (let i = 0; i < SIM_ROUNDS; i++) {
			const u = rng();
			let k = N; // default last bucket if all CDF entries < u (floating-point safety)
			for (let j = 0; j <= N; j++) {
				if (u <= cdf[j]) {
					k = j;
					break;
				}
			}
			hitCounts[k]++;
			const mult = pt[k];
			const payout = (stakeE18 * mult) / 10n ** 18n;
			totalStakeE18 += stakeE18;
			totalPayoutE18 += payout;
			if (payout > 0n) hits++;
			if (payout > stakeE18) profits++;
			if (mult > maxMultE18) maxMultE18 = mult;
		}

		const realizedPct = Number((totalPayoutE18 * 10_000_000n) / totalStakeE18) / 100_000;
		const edgePct = 100 - realizedPct;
		const analyticEdgePct = 100 - analyticPct;
		const passEdge = analyticEdgePct + 1e-9 >= EDGE_FLOOR_PCT;

		console.log(`==== Pick ${N} ====`);
		console.log(`Paytable (×):    [${pt.map(fmtMult).join(', ')}]`);
		console.log(
			`Analytic RTP:    ${analyticPct.toFixed(4)}%  (edge ${analyticEdgePct.toFixed(4)}%)${
				passEdge ? '' : `  ⚠ BELOW ${EDGE_FLOOR_PCT}% FLOOR`
			}`
		);
		console.log(`Realized RTP:    ${realizedPct.toFixed(4)}%  (edge ${edgePct.toFixed(4)}%)`);
		console.log(`Max mult hit:    ${fmtMult(maxMultE18)}x`);
		console.log(`Hit rate:        ${((hits / SIM_ROUNDS) * 100).toFixed(2)}% (payout > 0)`);
		console.log(`Profit rate:     ${((profits / SIM_ROUNDS) * 100).toFixed(2)}% (payout > stake)`);
		console.log(`Hit distribution (realized vs expected):`);
		console.log(`   k       count       realized       expected`);
		for (let k = 0; k <= N; k++) {
			const realFrac = hitCounts[k] / SIM_ROUNDS;
			const expFrac = probs[k];
			console.log(
				`   ${k.toString().padStart(2)}  ${String(hitCounts[k]).padStart(10)}    ${(realFrac * 100)
					.toFixed(4)
					.padStart(8)}%    ${(expFrac * 100).toFixed(4).padStart(8)}%`
			);
		}
		console.log('');

		results.push({
			pick: N,
			analyticPct,
			analyticEdgePct,
			realizedPct,
			realizedEdgePct: edgePct,
			maxMultX: Number(maxMultE18) / 1e18,
			passEdge,
		});
	}

	console.log('========== SUMMARY ==========');
	console.log('pick   analytic   analyticEdge   realized   realizedEdge   maxX    pass2%?');
	for (const r of results) {
		console.log(
			`${r.pick.toString().padStart(4)}    ${r.analyticPct
				.toFixed(3)
				.padStart(7)}%      ${r.analyticEdgePct.toFixed(3).padStart(6)}%    ${r.realizedPct
				.toFixed(3)
				.padStart(7)}%      ${r.realizedEdgePct.toFixed(3).padStart(6)}%   ${r.maxMultX
				.toFixed(2)
				.padStart(6)}    ${r.passEdge ? 'PASS' : '** FAIL **'}`
		);
	}
	console.log('');

	const failed = results.filter((r) => !r.passEdge);
	if (failed.length > 0) {
		console.log(
			`FAIL: ${failed.length} pick count(s) below ${EDGE_FLOOR_PCT}% analytic edge floor: ${failed
				.map((r) => `Pick ${r.pick} (${r.analyticEdgePct.toFixed(3)}%)`)
				.join(', ')}`
		);
		process.exitCode = 1;
	} else {
		console.log(`PASS: all pick counts meet ≥${EDGE_FLOOR_PCT}% analytic edge floor.`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
