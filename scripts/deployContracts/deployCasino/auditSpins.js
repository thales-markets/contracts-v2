const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

// Reads every spin on the current Slots contract, verifies each payout
// against the configured pair/triple tables + house edge, and reports
// empirical vs analytic hit rate and RTP.

async function main() {
	const network = (await ethers.provider.getNetwork()).name;
	const slotsAddress = getTargetAddress('Slots', network);
	const slots = await ethers.getContractAt('Slots', slotsAddress);

	// ---------- config ----------
	const symbolCount = Number(await slots.symbolCount());
	const houseEdge = Number(ethers.formatEther(await slots.houseEdge()));

	const weights = [];
	const pair = [];
	const triple = [];
	for (let i = 0; i < symbolCount; i++) {
		weights.push(Number(await slots.symbolWeights(i)));
		pair.push(Number(ethers.formatEther(await slots.pairPayout(i))));
		triple.push(Number(ethers.formatEther(await slots.triplePayout(i))));
	}
	const totalWeight = weights.reduce((a, b) => a + b, 0);
	const p = weights.map((w) => w / totalWeight);

	console.log('=============== CONFIG ===============');
	console.log('houseEdge:   ', houseEdge);
	console.log('symbolCount: ', symbolCount);
	console.log('weights:     ', weights, `(sum=${totalWeight})`);
	console.log(
		'probs:       ',
		p.map((x) => x.toFixed(4))
	);
	console.log('pair:        ', pair);
	console.log('triple:      ', triple);

	// ---------- analytic RTP ----------
	let analyticHit = 0;
	let analyticRtp = 0;
	for (let i = 0; i < symbolCount; i++) {
		const pairProb = 2 * p[i] * p[i] * (1 - p[i]);
		const tripleProb = p[i] ** 3;
		analyticHit += pairProb + tripleProb;
		analyticRtp += pairProb * (1 + (1 - houseEdge) * pair[i]);
		analyticRtp += tripleProb * (1 + (1 - houseEdge) * triple[i]);
	}
	console.log('\n=============== ANALYTIC ===============');
	console.log(
		`hit rate:  ${(analyticHit * 100).toFixed(3)}% (1 in ${(1 / analyticHit).toFixed(3)})`
	);
	console.log(`RTP:       ${(analyticRtp * 100).toFixed(3)}%`);
	console.log(`edge:      ${((1 - analyticRtp) * 100).toFixed(3)}%`);

	// ---------- on-chain spins ----------
	const nextSpinId = Number(await slots.nextSpinId());
	const totalSpins = nextSpinId - 1;
	console.log('\n=============== ON-CHAIN SPINS ===============');
	console.log(`nextSpinId = ${nextSpinId}, total placed = ${totalSpins}`);
	if (totalSpins === 0) {
		console.log('No spins to audit.');
		return;
	}

	let resolved = 0;
	let wins = 0;
	let pending = 0;
	let cancelled = 0;
	let totalStake = 0;
	let totalPayout = 0;
	let payoutMismatches = 0;
	const symbolFreq = new Array(symbolCount).fill(0);

	for (let id = 1; id < nextSpinId; id++) {
		const base = await slots.getSpinBase(id);
		const details = await slots.getSpinDetails(id);
		const status = Number(details.status);
		const statusName = ['NONE', 'PENDING', 'RESOLVED', 'CANCELLED'][status];

		const stake = Number(ethers.formatUnits(base.amount, 6));
		const payoutUsd = Number(ethers.formatUnits(base.payout, 6));
		const r0 = Number(details.reels[0]);
		const r1 = Number(details.reels[1]);
		const r2 = Number(details.reels[2]);

		// what SHOULD the payout be given the reels?
		let expectedMultiplier = 0;
		let kind = 'lose';
		if (r0 === r1 && r1 === r2) {
			expectedMultiplier = triple[r0] * (1 - houseEdge);
			kind = `triple[${r0}]`;
		} else if (r0 === r1) {
			expectedMultiplier = pair[r0] * (1 - houseEdge);
			kind = `pair[${r0}]`;
		} else if (r1 === r2) {
			expectedMultiplier = pair[r1] * (1 - houseEdge);
			kind = `pair[${r1}]`;
		}
		const expectedPayout = expectedMultiplier > 0 ? stake * (1 + expectedMultiplier) : 0;

		const line =
			`  #${id.toString().padStart(2)} ${statusName.padEnd(9)} ` +
			`reels=[${r0},${r1},${r2}] won=${details.won ? 'Y' : 'N'} ` +
			`stake=${stake.toFixed(2)} payout=${payoutUsd.toFixed(4)} ` +
			`expected=${expectedPayout.toFixed(4)} (${kind})`;

		// sanity check
		let flag = '';
		if (status === 2) {
			// RESOLVED
			if (Math.abs(payoutUsd - expectedPayout) > 1e-4) {
				payoutMismatches++;
				flag = '  <-- PAYOUT MISMATCH';
			}
			resolved++;
			totalStake += stake;
			totalPayout += payoutUsd;
			if (details.won) wins++;
		} else if (status === 1) pending++;
		else if (status === 3) cancelled++;

		if (status === 2) {
			symbolFreq[r0]++;
			symbolFreq[r1]++;
			symbolFreq[r2]++;
		}

		console.log(line + flag);
	}

	console.log('\n=============== SUMMARY ===============');
	console.log(`resolved:         ${resolved}`);
	console.log(`pending:          ${pending}`);
	console.log(`cancelled:        ${cancelled}`);
	console.log(`wins:             ${wins} / ${resolved}`);
	console.log(`payout mismatches: ${payoutMismatches}`);

	if (resolved > 0) {
		const empHitRate = wins / resolved;
		const empRtp = totalStake > 0 ? totalPayout / totalStake : 0;
		console.log(`\nEmpirical hit rate: ${(empHitRate * 100).toFixed(2)}%`);
		console.log(`Analytic hit rate:  ${(analyticHit * 100).toFixed(2)}%`);
		console.log(`Empirical RTP:      ${(empRtp * 100).toFixed(2)}%`);
		console.log(`Analytic RTP:       ${(analyticRtp * 100).toFixed(2)}%`);

		// binomial probability of seeing this many wins or more
		const n = resolved;
		const pWin = analyticHit;
		// P(X >= wins)
		function binomCoef(n, k) {
			if (k < 0 || k > n) return 0;
			if (k === 0 || k === n) return 1;
			let r = 1;
			for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
			return r;
		}
		let pTail = 0;
		for (let k = wins; k <= n; k++) {
			pTail += binomCoef(n, k) * Math.pow(pWin, k) * Math.pow(1 - pWin, n - k);
		}
		console.log(
			`\nP(X >= ${wins} wins in ${n} spins | analytic hit rate): ${(pTail * 100).toFixed(2)}%`
		);

		// reel-symbol frequency vs expected
		const totalDraws = resolved * 3;
		console.log(`\nReel-symbol frequency (${totalDraws} draws total):`);
		let chiSq = 0;
		for (let i = 0; i < symbolCount; i++) {
			const obs = symbolFreq[i];
			const exp = totalDraws * p[i];
			if (exp > 0) chiSq += ((obs - exp) * (obs - exp)) / exp;
			console.log(
				`  symbol ${i}: observed ${obs.toString().padStart(3)} ` +
					`(${((obs / totalDraws) * 100).toFixed(1).padStart(5)}%)` +
					` expected ${exp.toFixed(1).padStart(5)} (${(p[i] * 100).toFixed(1)}%)`
			);
		}
		console.log(`Chi-square statistic: ${chiSq.toFixed(2)} (df=${symbolCount - 1})`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
