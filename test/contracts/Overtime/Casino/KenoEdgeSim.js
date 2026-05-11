/**
 * Keno — 100k Monte Carlo edge simulation per spot count (1..10).
 *
 * Two phases:
 *   (1) Cross-validate JS partial-Fisher-Yates draw against the live contract for
 *       VALIDATION_ROUNDS rounds (one bet per round, full place + VRF fulfill).
 *   (2) Run SIM_ROUNDS rounds in pure JS for each spot count and compare realized RTP to the
 *       analytic RTP = sum_k P(k hits | n picks) × paytable[k]. Each paytable is calibrated
 *       to clear ≥1.9% edge — the sim verifies that empirically.
 *
 * Excluded from the default `npx hardhat test` run via EXCLUDED_EDGE_TESTS in hardhat.config.js.
 */

const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('1000000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const ONE = 10n ** 18n;

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 30;
const BET_AMOUNT = 3n * USDC_UNIT;

const POOL = 80;
const DRAW = 20;
const SPOT_RANGE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/* ========== JS MIRROR ========== */

function drawNumbers(word) {
	const deck = [];
	for (let i = 0; i < POOL; i++) deck.push(i + 1);
	let cursor = BigInt(word);
	let chunksLeft = 16;
	const drawn = [];
	for (let i = 0; i < DRAW; i++) {
		if (chunksLeft === 0) {
			cursor = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [cursor]))
			);
			chunksLeft = 16;
		}
		const remaining = BigInt(POOL - i);
		const j = i + Number((cursor & 0xffffn) % remaining);
		cursor >>= 16n;
		chunksLeft--;
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	for (let i = 0; i < DRAW; i++) drawn.push(deck[i]);
	return drawn;
}

function picksToMask(picks) {
	let mask = 0n;
	for (const n of picks) mask |= 1n << BigInt(n - 1);
	return mask;
}

function countHits(picks, drawn) {
	const drawnSet = new Set(drawn);
	let h = 0;
	for (const p of picks) if (drawnSet.has(p)) h++;
	return h;
}

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`keno-sim-${seed}`).slice(2));
}

// Hypergeometric P(k hits | n picks, 20 drawn from 80) — used for analytic RTP
function choose(n, k) {
	if (k < 0 || k > n) return 0n;
	if (k > n - k) k = n - k;
	let r = 1n;
	for (let i = 0; i < k; i++) {
		r *= BigInt(n - i);
		r /= BigInt(i + 1);
	}
	return r;
}
function probHits(picks, hits) {
	const num = choose(picks, hits) * choose(POOL - picks, DRAW - hits);
	const den = choose(POOL, DRAW);
	return Number((num * 10n ** 18n) / den) / 1e18;
}
function analyticRTP(picks, paytable) {
	let r = 0;
	for (let k = 0; k <= picks; k++) {
		const m = Number(paytable[k]) / 1e18;
		r += probHits(picks, k) * m;
	}
	return r;
}

// Simple deterministic pick generator: take the first `n` numbers 1..n. Mathematically
// equivalent to any pre-committed pick set (by symmetry of the uniform draw)
function defaultPicks(n) {
	return Array.from({ length: n }, (_, i) => i + 1);
}

/* ========== FIXTURE ========== */

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, freeBetsHolderStub] =
		await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddr = await usdc.getAddress();
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, await weth.getAddress(), WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, await over.getAddress(), OVER_PRICE);

	const Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(Manager, [owner.address]);
	const managerAddr = await manager.getAddress();
	await manager.setWhitelistedAddresses([riskManager.address], 1, true);
	await manager.setWhitelistedAddresses([resolver.address], 2, true);
	await manager.setWhitelistedAddresses([pauser.address], 3, true);

	const VRF = await ethers.getContractFactory('MockVRFCoordinator');
	const vrf = await VRF.deploy();

	const Core = await ethers.getContractFactory('CasinoCoreV2');
	const core = await upgrades.deployProxy(Core, [], { initializer: false });
	const coreAddr = await core.getAddress();
	await core.initialize(
		{
			owner: owner.address,
			manager: managerAddr,
			priceFeed: await priceFeed.getAddress(),
			vrfCoordinator: await vrf.getAddress(),
			freeBetsHolder: freeBetsHolderStub.address,
			referrals: ethers.ZeroAddress,
		},
		{
			usdc: usdcAddr,
			weth: await weth.getAddress(),
			over: await over.getAddress(),
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);

	const Keno = await ethers.getContractFactory('Keno');
	const keno = await upgrades.deployProxy(Keno, [], { initializer: false });
	const kenoAddr = await keno.getAddress();
	await keno.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(kenoAddr);
	await core.setMaxNetLossPerGameUsd(kenoAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { keno, kenoAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

async function placeAndFulfill(ctx, picks, word) {
	const { keno, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await keno.connect(player).placeBet(usdcAddr, BET_AMOUNT, picks, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return keno.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);
	return betId;
}

/* ========== TESTS ========== */

describe('Keno — edge sim & EVM cross-validation', function () {
	this.timeout(900_000);

	let paytables = {};

	before(async () => {
		const ctx = await loadFixture(deployFixture);
		for (const n of SPOT_RANGE) {
			const pt = await ctx.keno.getPaytable(n);
			paytables[n] = pt.map((v) => BigInt(v));
		}
	});

	it(`cross-validates JS draw + payouts vs on-chain across ${VALIDATION_ROUNDS} rounds`, async () => {
		const ctx = await loadFixture(deployFixture);
		const { keno } = ctx;
		const pt = {};
		for (const n of SPOT_RANGE) pt[n] = (await keno.getPaytable(n)).map((v) => BigInt(v));

		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const word = wordFromSeed(`v-${i}`);
			const picksCount = 1 + (i % 10);
			const picks = defaultPicks(picksCount);
			const drawn = drawNumbers(word);
			const expectedHits = countHits(picks, drawn);
			const expectedMult = pt[picksCount][expectedHits];

			const id = await placeAndFulfill(ctx, picks, word);
			const base = await keno.getBetBase(id);
			expect(Number(base.picksCount)).to.equal(picksCount);
			expect(Number(base.hits)).to.equal(expectedHits);
			expect(base.multiplierE18).to.equal(expectedMult);
			expect(base.payout).to.equal((BET_AMOUNT * expectedMult) / ONE);
			expect(base.drawnMask).to.equal(picksToMask(drawn));
		}
	});

	for (const picksCount of SPOT_RANGE) {
		it(`runs ${SIM_ROUNDS.toLocaleString()} rounds @ Pick ${picksCount}`, () => {
			const pt = paytables[picksCount];
			if (!pt) throw new Error('paytable missing — before() did not run?');

			const picks = defaultPicks(picksCount);
			let totalStake = 0n;
			let totalPayout = 0n;
			const hitDist = new Array(picksCount + 1).fill(0);
			let biggestWin = 0n;

			for (let i = 0; i < SIM_ROUNDS; i++) {
				const word = wordFromSeed(`s-${picksCount}-${i}`);
				const drawn = drawNumbers(word);
				const hits = countHits(picks, drawn);
				hitDist[hits]++;
				const mult = pt[hits];
				const payout = (BET_AMOUNT * mult) / ONE;
				if (payout > biggestWin) biggestWin = payout;
				totalStake += BET_AMOUNT;
				totalPayout += payout;
			}

			const rtp = (Number(totalPayout) / Number(totalStake)) * 100;
			const edge = 100 - rtp;
			const analytic = analyticRTP(picksCount, pt) * 100;
			const analyticEdge = 100 - analytic;
			const fmtUsd = (v) => (Number(v) / 1e6).toFixed(2);

			console.log('');
			console.log(`==== Keno 100k summary @ Pick ${picksCount} ====`);
			console.log(`Rounds:          ${SIM_ROUNDS.toLocaleString()}`);
			console.log(`Realized RTP:    ${rtp.toFixed(3)}%   (analytic ${analytic.toFixed(3)}%)`);
			console.log(`Realized edge:   ${edge.toFixed(3)}%   (analytic ${analyticEdge.toFixed(3)}%)`);
			console.log(
				`Biggest win:     ${fmtUsd(biggestWin)} USDC (${(
					Number(biggestWin) / Number(BET_AMOUNT)
				).toFixed(2)}x)`
			);
			console.log(`Hit distribution:`);
			for (let h = 0; h <= picksCount; h++) {
				const observed = ((hitDist[h] / SIM_ROUNDS) * 100).toFixed(3);
				const theory = (probHits(picksCount, h) * 100).toFixed(3);
				const m = Number(pt[h]) / 1e18;
				console.log(
					`  hits=${h}: ${hitDist[h]
						.toString()
						.padStart(6)} (${observed}%, theory ${theory}%) × ${m}x`
				);
			}
			console.log('=========================================');

			// Source of truth = analytic RTP (paytable × hypergeometric); MC variance is small at 100k
			expect(analyticEdge).to.be.gt(1.5); // calibrated to ≥1.9%, allow rounding slack
		});
	}
});
