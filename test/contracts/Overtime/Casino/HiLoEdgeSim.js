/**
 * HiLo — 100k Monte Carlo edge simulation.
 *
 * Two phases:
 *   (1) Cross-validate JS RNG (`card = word % 52`, `rank = card / 4`) and the multiplier-factor
 *       formula against the live contract for VALIDATION_ROUNDS rounds (full play-throughs).
 *   (2) Run SIM_ROUNDS rounds in pure JS using a fixed cashout-after-K-correct-guesses strategy
 *       across multiple K values. The single-guess EV is (1 - HE) regardless of direction by
 *       design: factor = (12 - 13·HE) / count_winning_ranks. Realized RTP should converge to
 *       (1 - HE)^K times the prob of getting K wins... NO — actually composition of independent
 *       guesses each with EV (1 - HE) on stake-at-risk gives RTP = 1 - HE per round, full stop.
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
const MAX_MULT_E18 = 1000n * ONE;

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 30;
const BET_AMOUNT = 3n * USDC_UNIT;

const Direction = { HIGHER: 0, LOWER: 1 };

function rankOf(card) {
	return Math.floor(card / 4); // 0..12
}

function factorE18(direction, rank, heE18 = HE_E18) {
	const num = 12n * ONE - 13n * heE18;
	let count;
	if (direction === Direction.HIGHER) {
		if (rank >= 12) return 0n;
		count = BigInt(12 - rank);
	} else {
		if (rank === 0) return 0n;
		count = BigInt(rank);
	}
	return num / count;
}

// Optimal direction: pick the side with strictly more winning ranks.
// Ties (rank == 6) → HIGHER (arbitrary; symmetric EV).
function chooseDir(rank) {
	if (rank < 6) return Direction.HIGHER;
	if (rank > 6) return Direction.LOWER;
	return Direction.HIGHER;
}

function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`hilo-sim-${seed}`).slice(2));
}

// Simulate one round in pure JS: place bet → first card → up to K correct guesses, then cashout.
// Returns { stake, payout } — payout is 0 on wrong guess, stake*currentMult on cashout.
function simulateRound(seed, cashoutAfter) {
	let mult = ONE;
	const firstWord = wordFromSeed(`${seed}-c0`);
	let card = Number(firstWord % 52n);
	let correct = 0;
	let push = 0;
	let guess = 0;

	while (correct < cashoutAfter) {
		const rank = rankOf(card);
		const dir = chooseDir(rank);
		guess++;
		const w = wordFromSeed(`${seed}-c${guess}`);
		const newCard = Number(w % 52n);
		const newRank = rankOf(newCard);

		if (newRank === rank) {
			push++;
			card = newCard;
			continue;
		}

		const win =
			(dir === Direction.HIGHER && newRank > rank) || (dir === Direction.LOWER && newRank < rank);

		if (!win) {
			return { stake: BET_AMOUNT, payout: 0n, correct, push, guesses: guess, mult: 0n };
		}

		const f = factorE18(dir, rank);
		mult = (mult * f) / ONE;
		if (mult > MAX_MULT_E18) mult = MAX_MULT_E18;
		correct++;
		card = newCard;
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
	await core.connect(riskManager).setMaxNetLossPerGameUsd(hiloAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return { hilo, hiloAddr, vrf, core, coreAddr, usdc, usdcAddr, player };
}

async function placeAndDrawFirst(ctx, firstWord) {
	const { hilo, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await hilo.connect(player).placeBet(usdcAddr, BET_AMOUNT, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return hilo.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [firstWord]);
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

		// Each validation round plays at most 3 guesses against the contract
		const K = 3;
		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const seed = `v-${i}`;
			const firstWord = wordFromSeed(`${seed}-c0`);
			const betId = await placeAndDrawFirst(ctx, firstWord);
			const expFirstCard = Number(firstWord % 52n);
			const stateAfterFirst = await hilo.getBetState(betId);
			expect(Number(stateAfterFirst.currentCard)).to.equal(expFirstCard);

			let card = expFirstCard;
			let mult = ONE;
			let alive = true;
			let correct = 0;

			for (let g = 0; alive && correct < K; g++) {
				const rank = rankOf(card);
				const dir = chooseDir(rank);
				const w = wordFromSeed(`${seed}-c${g + 1}`);
				const newCard = Number(w % 52n);
				const newRank = rankOf(newCard);
				await guessAndDeal(ctx, betId, dir, w);
				const st = await hilo.getBetState(betId);
				expect(Number(st.currentCard)).to.equal(newCard);

				if (newRank === rank) {
					// push: multiplier unchanged
					expect(st.currentMultiplierE18).to.equal(mult);
				} else {
					const win =
						(dir === Direction.HIGHER && newRank > rank) ||
						(dir === Direction.LOWER && newRank < rank);
					if (win) {
						mult = (mult * factorE18(dir, rank)) / ONE;
						if (mult > MAX_MULT_E18) mult = MAX_MULT_E18;
						expect(st.currentMultiplierE18).to.equal(mult);
						correct++;
					} else {
						alive = false;
						const base = await hilo.getBetBase(betId);
						expect(Number(base.outcome)).to.equal(2 /* WRONG_GUESS */);
					}
				}
				card = newCard;
			}

			if (alive) {
				await hilo.connect(player).cashout(betId);
				const base = await hilo.getBetBase(betId);
				expect(Number(base.outcome)).to.equal(1 /* CASHED_OUT */);
				expect(base.payout).to.equal((BET_AMOUNT * mult) / ONE);
			}
		}
	});

	for (const K of [1, 3, 5]) {
		it(`runs ${SIM_ROUNDS.toLocaleString()} rounds with cashout-after-${K}-correct strategy`, () => {
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

			const rtp = (Number(totalPayout) / Number(totalStake)) * 100;
			const edge = 100 - rtp;
			const cashoutRate = (cashouts / SIM_ROUNDS) * 100;

			console.log('');
			console.log(`==== HiLo 100k summary @ cashout-after-${K} correct ====`);
			console.log(`Rounds:            ${SIM_ROUNDS.toLocaleString()}`);
			console.log(`Cashouts:          ${cashouts} (${cashoutRate.toFixed(2)}%)`);
			console.log(`Wrong guesses:     ${wrongs} (${((wrongs / SIM_ROUNDS) * 100).toFixed(2)}%)`);
			console.log(`Pushes (any):      ${pushes}`);
			console.log(`Avg guesses/round: ${(totalGuesses / SIM_ROUNDS).toFixed(2)}`);
			console.log(`Realized RTP:      ${rtp.toFixed(2)}%   (target 98.00%)`);
			console.log(`Realized edge:     ${edge.toFixed(2)}%   (target 2.00%)`);
			console.log('========================================================');

			// Loose floor: edge can swing significantly under variance especially for high K
			// (low cashout rate, fat tails). Just guard against catastrophic miscalibration.
			expect(edge).to.be.gt(-5);
		});
	}
});
