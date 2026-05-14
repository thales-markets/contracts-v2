/**
 * HiLo — Monte Carlo edge simulation for the shipped midpoint-8 game.
 *
 * Game: each round draws `randomWord % 52`, takes rank = card/4 (0..12). Compares against the
 * constant MIDPOINT (rank 6 = card "8"). Outcomes per round:
 *   • rank == 6              → PUSH (multiplier unchanged, round continues)
 *   • rank matches direction → HIT  (multiplier *= factor = (12·ONE − 13·HE)/6, capped at MAX)
 *   • rank against direction → BUST (lose stake)
 * Direction is chosen each round and is symmetric (6 winning ranks either way), so any constant
 * direction has identical EV. We use ABOVE throughout for simplicity.
 *
 * Two phases:
 *   (1) Cross-validate JS sim vs on-chain `lastCard` and `currentMultiplierE18` for
 *       VALIDATION_ROUNDS rounds (full play-throughs up to cashout / bust).
 *   (2) Run SIM_ROUNDS rounds in pure JS for cashout-after-K-HITS strategies (K ∈ {1,3,5}) and
 *       assert empirical RTP converges to (factor / 2)^K (with cap at maxMult applied) within a
 *       tolerance derived from the 1/2 hit-vs-bust binomial variance.
 *
 * Expected closed-form RTPs at HE=2%, factor ≈ 1.9567x, cap = 25x:
 *   K=1: (1.9567/2)^1                            = 0.9783 → edge 2.17%
 *   K=3: (1.9567/2)^3                            = 0.9364 → edge 6.36%
 *   K=5: (1/2)^5 · min(1.9567^5, 25) = 0.03125·25 = 0.7813 → edge 21.87%  (cap engages)
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
const MAX_PROFIT_USD = ethers.parseEther('100000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const ONE = 10n ** 18n;
const HE_E18 = 2n * 10n ** 16n; // 2%
const MAX_MULT_E18 = 25n * ONE;
const MIDPOINT_RANK = 6;

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 30;
const BET_AMOUNT = 3n * USDC_UNIT;

// Matches the Direction enum in ICasinoHiLo (ABOVE = 0, BELOW = 1)
const Direction = { ABOVE: 0, BELOW: 1 };

const CardOutcome = { HIT: 0, PUSH: 1, BUST: 2 };
const Outcome = { NONE: 0, CASHED_OUT: 1, WRONG_GUESS: 2, CANCELLED: 3 };

function rankOf(card) {
	return Math.floor(card / 4); // 0..12
}

function factorE18(heE18 = HE_E18) {
	// Mirrors HiLo._multiplierFactorE18 exactly (integer-divides by 6)
	return (12n * ONE - 13n * heE18) / 6n;
}

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`hilo-sim-${seed}`).slice(2));
}

function classify(rank, dir) {
	if (rank === MIDPOINT_RANK) return CardOutcome.PUSH;
	const win =
		(dir === Direction.ABOVE && rank > MIDPOINT_RANK) ||
		(dir === Direction.BELOW && rank < MIDPOINT_RANK);
	return win ? CardOutcome.HIT : CardOutcome.BUST;
}

// Simulate one round in pure JS: keep guessing ABOVE until we've hit K times (then cashout) or
// until we bust. Pushes are free re-rolls (multiplier unchanged, round continues).
function simulateRound(seed, cashoutAfter) {
	let mult = ONE;
	let correct = 0;
	let push = 0;
	let guess = 0;
	const factor = factorE18();

	while (correct < cashoutAfter) {
		guess++;
		const w = wordFromSeed(`${seed}-c${guess}`);
		const card = Number(w % 52n);
		const rank = rankOf(card);
		const oc = classify(rank, Direction.ABOVE);

		if (oc === CardOutcome.PUSH) {
			push++;
			continue;
		}
		if (oc === CardOutcome.BUST) {
			return { stake: BET_AMOUNT, payout: 0n, correct, push, guesses: guess, mult: 0n };
		}
		// HIT
		mult = (mult * factor) / ONE;
		if (mult > MAX_MULT_E18) mult = MAX_MULT_E18;
		correct++;
	}

	const payout = (BET_AMOUNT * mult) / ONE;
	return { stake: BET_AMOUNT, payout, correct, push, guesses: guess, mult };
}

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

	const HiLo = await ethers.getContractFactory('HiLo');
	const hilo = await upgrades.deployProxy(HiLo, [], { initializer: false });
	const hiloAddr = await hilo.getAddress();
	await hilo.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(hiloAddr);
	await core.setMaxNetLossPerGameUsd(hiloAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { hilo, hiloAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

async function placeAndDrawFirst(ctx, firstWord, firstDirection = Direction.ABOVE) {
	const { hilo, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await hilo
		.connect(player)
		.placeBet(usdcAddr, BET_AMOUNT, ethers.ZeroAddress, firstDirection);
	const receipt = await tx.wait();
	const guessed = receipt.logs
		.map((l) => {
			try {
				return hilo.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'GuessChosen');
	const betId = guessed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, guessed.args.requestId, [firstWord]);
	return betId;
}

async function guessAndDeal(ctx, betId, dir, nextWord) {
	const { hilo, vrf, coreAddr, player } = ctx;
	const tx = await hilo.connect(player).guess(betId, dir);
	const receipt = await tx.wait();
	const ev = receipt.logs
		.map((l) => {
			try {
				return hilo.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'GuessChosen');
	await vrf.fulfillRandomWords(coreAddr, ev.args.requestId, [nextWord]);
}

describe('HiLo — edge sim & EVM cross-validation', function () {
	this.timeout(600_000);

	it(`cross-validates JS sim vs on-chain logic across ${VALIDATION_ROUNDS} rounds`, async () => {
		const ctx = await loadFixture(deployFixture);
		const { hilo, player } = ctx;

		// Each validation round plays at most K hits' worth of guesses against the contract
		const K = 3;
		const factor = factorE18();

		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const seed = `v-${i}`;
			const firstWord = wordFromSeed(`${seed}-c1`);
			const betId = await placeAndDrawFirst(ctx, firstWord, Direction.ABOVE);

			let card = Number(firstWord % 52n);
			let rank = rankOf(card);
			let mult = ONE;
			let correct = 0;
			let alive = true;

			// First card already drawn by placeAndDrawFirst. Apply its outcome.
			{
				const oc = classify(rank, Direction.ABOVE);
				const state = await hilo.getBetState(betId);
				expect(Number(state.lastCard)).to.equal(card);

				if (oc === CardOutcome.PUSH) {
					expect(state.currentMultiplierE18).to.equal(mult); // unchanged
				} else if (oc === CardOutcome.HIT) {
					mult = (mult * factor) / ONE;
					if (mult > MAX_MULT_E18) mult = MAX_MULT_E18;
					expect(state.currentMultiplierE18).to.equal(mult);
					correct++;
				} else {
					alive = false;
					const base = await hilo.getBetBase(betId);
					expect(Number(base.outcome)).to.equal(Outcome.WRONG_GUESS);
				}
			}

			// Subsequent guesses
			for (let g = 2; alive && correct < K; g++) {
				const w = wordFromSeed(`${seed}-c${g}`);
				const newCard = Number(w % 52n);
				const newRank = rankOf(newCard);
				await guessAndDeal(ctx, betId, Direction.ABOVE, w);

				const oc = classify(newRank, Direction.ABOVE);
				const st = await hilo.getBetState(betId);
				expect(Number(st.lastCard)).to.equal(newCard);

				if (oc === CardOutcome.PUSH) {
					expect(st.currentMultiplierE18).to.equal(mult); // unchanged
				} else if (oc === CardOutcome.HIT) {
					mult = (mult * factor) / ONE;
					if (mult > MAX_MULT_E18) mult = MAX_MULT_E18;
					expect(st.currentMultiplierE18).to.equal(mult);
					correct++;
				} else {
					alive = false;
					const base = await hilo.getBetBase(betId);
					expect(Number(base.outcome)).to.equal(Outcome.WRONG_GUESS);
				}
				card = newCard;
				rank = newRank;
			}

			if (alive) {
				await hilo.connect(player).cashout(betId);
				const base = await hilo.getBetBase(betId);
				expect(Number(base.outcome)).to.equal(Outcome.CASHED_OUT);
				expect(base.payout).to.equal((BET_AMOUNT * mult) / ONE);
			}
		}
	});

	// Closed-form expected RTPs at HE=2%, factor ≈ 1.9567x, cap = 25x:
	//   K=1: 0.97833...  (no cap)
	//   K=3: 0.93645...  (no cap; factor^3 = 7.4925 < 25)
	//   K=5: 0.78125     (cap engages; (1/2)^5 * 25 = 0.78125)
	const EXPECTED_RTP = {
		1: 0.9783333,
		3: 0.9364582,
		5: 0.78125,
	};

	for (const K of [1, 3, 5]) {
		it(`runs ${SIM_ROUNDS.toLocaleString()} rounds with cashout-after-${K}-hits strategy`, () => {
			let totalStake = 0n;
			let totalPayout = 0n;
			let cashouts = 0;
			let wrongs = 0;
			let pushes = 0;
			let totalGuesses = 0;

			for (let i = 0; i < SIM_ROUNDS; i++) {
				const r = simulateRound(`s-${K}-${i}`, K);
				totalStake += r.stake;
				totalPayout += r.payout;
				totalGuesses += r.guesses;
				pushes += r.push;
				if (r.payout > 0n) cashouts++;
				else wrongs++;
			}

			const rtp = Number(totalPayout) / Number(totalStake);
			const edge = 1 - rtp;
			const cashoutRate = cashouts / SIM_ROUNDS;
			const expectedRtp = EXPECTED_RTP[K];
			const expectedEdge = 1 - expectedRtp;
			const drift = Math.abs(rtp - expectedRtp);

			console.log('');
			console.log(
				`==== HiLo ${SIM_ROUNDS.toLocaleString()} summary @ cashout-after-${K}-hits ====`
			);
			console.log(`Cashouts:          ${cashouts} (${(cashoutRate * 100).toFixed(2)}%)`);
			console.log(`Wrong guesses:     ${wrongs} (${((wrongs / SIM_ROUNDS) * 100).toFixed(2)}%)`);
			console.log(`Pushes (any):      ${pushes}`);
			console.log(`Avg guesses/round: ${(totalGuesses / SIM_ROUNDS).toFixed(2)}`);
			console.log(
				`Realized RTP:      ${(rtp * 100).toFixed(3)}%   (target ${(expectedRtp * 100).toFixed(
					3
				)}%)`
			);
			console.log(
				`Realized edge:     ${(edge * 100).toFixed(3)}%   (target ${(expectedEdge * 100).toFixed(
					3
				)}%)`
			);
			console.log(`RTP drift:         ${(drift * 100).toFixed(3)}%`);
			console.log('========================================================');

			// Tolerance: each non-push round is hit/bust 50/50. Payout when hitting K times is
			// stake * (capped) factor^K. Variance is dominated by the rare-win tail. A 3σ band
			// computed from binomial variance on the success rate p = (1/2)^K is:
			//   σ_rtp = mult_on_success * sqrt(p*(1-p)/N)
			// For K=5, mult_on_success = 25, p = 1/32 → σ ≈ 25 * sqrt((1/32)(31/32)/N) ≈ 0.0137
			// over 100k rounds. 3σ ≈ 4.1%. We use 5% as the gate to keep CI noise-tolerant.
			const TOLERANCE = 0.05;
			expect(drift).to.be.lt(
				TOLERANCE,
				`RTP drift ${drift} exceeds tolerance ${TOLERANCE} for K=${K}`
			);
			// Also assert the edge is positive (house never loses in expectation)
			expect(edge).to.be.gt(0);
		});
	}
});
