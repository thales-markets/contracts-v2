/**
 * Plinko on-chain edge verification — reads the deployed paytables for LOW/MED/HIGH from the
 * live Plinko proxy on optimisticSepolia and runs 100k pure-JS Monte Carlo sims per risk level
 * using those exact on-chain multipliers. Reports analytic RTP, realized RTP, edge, slot
 * distribution, max win, hit rate, profit rate. Asserts analytic edge ≥ 2%.
 *
 * Run: `npx hardhat run scripts/verifyPlinkoOnSepolia.js --network optimisticSepolia`
 */

const { ethers } = require('hardhat');
const deployments = require('./deployments.json');

const SIM_ROUNDS = 1_000_000;
const SLOT_WEIGHTS = [1, 8, 28, 56, 70, 56, 28, 8, 1];
const SLOT_WEIGHTS_SUM = 256;
const RISKS = [
	{ id: 0, name: 'LOW' },
	{ id: 1, name: 'MED' },
	{ id: 2, name: 'HIGH' },
];

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

function popcount8(n) {
	n = n - ((n >> 1) & 0x55);
	n = (n & 0x33) + ((n >> 2) & 0x33);
	return (n + (n >> 4)) & 0x0f;
}

function analyticRtpE18(paytableE18) {
	let acc = 0n;
	for (let i = 0; i < 9; i++) acc += BigInt(SLOT_WEIGHTS[i]) * paytableE18[i];
	return acc / BigInt(SLOT_WEIGHTS_SUM);
}

function fmtMult(e18) {
	return (Number(e18) / 1e18).toFixed(4);
}

function fmtPct(num, den) {
	if (den === 0n) return '0.0000%';
	return ((Number((num * 10_000_000n) / den) / 100_000) * 100).toFixed(4) + '%';
}

async function main() {
	const network = await ethers.provider.getNetwork();
	const chainId = Number(network.chainId);
	if (chainId !== 11155420) {
		throw new Error(`Expected optimisticSepolia (11155420), got chainId ${chainId}`);
	}

	const plinkoAddr = deployments.optimisticSepolia.Plinko;
	if (!plinkoAddr) throw new Error('Plinko address not in deployments.json for optimisticSepolia');

	const plinko = await ethers.getContractAt('Plinko', plinkoAddr);
	console.log(`Plinko proxy:    ${plinkoAddr}`);
	console.log(`Chain:           optimisticSepolia (${chainId})`);
	console.log(`Sims per risk:   ${SIM_ROUNDS.toLocaleString('en-US')}`);
	console.log('');

	const results = [];

	for (const r of RISKS) {
		const ptRaw = await plinko.getPaytable(r.id);
		const pt = ptRaw.map((v) => BigInt(v));
		if (pt.length !== 9) throw new Error(`paytable length ${pt.length} for risk ${r.name}`);

		console.log(`==== Risk ${r.name} (id=${r.id}) ====`);
		console.log(`Paytable (×):    [${pt.map(fmtMult).join(', ')}]`);

		const analyticE18 = analyticRtpE18(pt);
		const analyticPct = Number(analyticE18) / 1e16;
		console.log(
			`Analytic RTP:    ${analyticPct.toFixed(4)}%  (edge ${(100 - analyticPct).toFixed(4)}%)`
		);

		if (analyticE18 > 98n * 10n ** 16n) {
			console.log(`!! ANALYTIC RTP EXCEEDS 98% — would be rejected by EdgeFloorBreached on-chain`);
		}

		const rng = mulberry32(0xc0ffee + r.id * 7919);
		const slotCounts = new Array(9).fill(0);
		let totalStakeE18 = 0n;
		let totalPayoutE18 = 0n;
		const stakeE18 = 10n ** 18n;
		let hits = 0;
		let profits = 0;
		let maxMultE18 = 0n;

		for (let i = 0; i < SIM_ROUNDS; i++) {
			const word = (rng() * 4294967296) >>> 0;
			const slot = popcount8(word & 0xff);
			slotCounts[slot]++;
			const mult = pt[slot];
			const payout = (stakeE18 * mult) / 10n ** 18n;
			totalStakeE18 += stakeE18;
			totalPayoutE18 += payout;
			if (payout > 0n) hits++;
			if (payout > stakeE18) profits++;
			if (mult > maxMultE18) maxMultE18 = mult;
		}

		const realizedPct = Number((totalPayoutE18 * 10_000_000n) / totalStakeE18) / 100_000;
		const edgePct = 100 - realizedPct;

		console.log(`Realized RTP:    ${realizedPct.toFixed(4)}%  (edge ${edgePct.toFixed(4)}%)`);
		console.log(`Max mult hit:    ${fmtMult(maxMultE18)}x`);
		console.log(`Hit rate:        ${((hits / SIM_ROUNDS) * 100).toFixed(2)}% (payout > 0)`);
		console.log(`Profit rate:     ${((profits / SIM_ROUNDS) * 100).toFixed(2)}% (payout > stake)`);

		console.log(`Slot distribution (realized vs expected binomial):`);
		console.log(`   slot  count   realized   expected`);
		for (let i = 0; i < 9; i++) {
			const realFrac = slotCounts[i] / SIM_ROUNDS;
			const expFrac = SLOT_WEIGHTS[i] / SLOT_WEIGHTS_SUM;
			console.log(
				`   ${i}     ${String(slotCounts[i]).padStart(6)}  ${(realFrac * 100)
					.toFixed(3)
					.padStart(7)}%  ${(expFrac * 100).toFixed(3).padStart(7)}%`
			);
		}

		results.push({
			risk: r.name,
			paytable: pt.map(fmtMult),
			analyticPct,
			realizedPct,
			edgePct,
			maxMultX: Number(maxMultE18) / 1e18,
			hitRate: (hits / SIM_ROUNDS) * 100,
			profitRate: (profits / SIM_ROUNDS) * 100,
		});
		console.log('');
	}

	console.log('========== SUMMARY ==========');
	console.log('risk   analytic    realized    edge      maxX    hit%    profit%');
	for (const r of results) {
		console.log(
			`${r.risk.padEnd(5)}  ${r.analyticPct.toFixed(3).padStart(7)}%   ${r.realizedPct
				.toFixed(3)
				.padStart(7)}%   ${r.edgePct.toFixed(3).padStart(6)}%   ${r.maxMultX
				.toFixed(2)
				.padStart(5)}   ${r.hitRate.toFixed(1).padStart(4)}%   ${r.profitRate
				.toFixed(1)
				.padStart(4)}%`
		);
	}
	console.log('');

	for (const r of results) {
		if (r.analyticPct > 98) {
			console.log(
				`FAIL: ${r.risk} analytic RTP ${r.analyticPct.toFixed(3)}% > 98% (edge floor breached)`
			);
			process.exitCode = 1;
		}
	}
	if (!process.exitCode) console.log('PASS: all risk levels meet ≥2% analytic edge floor.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
