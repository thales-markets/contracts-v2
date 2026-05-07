/**
 * ThreeCardPoker — 100k Monte Carlo edge simulation.
 *
 * Two phases:
 *   (1) Cross-validate that the JS shuffle + hand evaluator matches the on-chain logic
 *       exactly, by running N rounds end-to-end against the live contract and asserting
 *       JS predictions match contract state.
 *   (2) Once validated, run 100k rounds in pure JS to compute realized house edge.
 *
 * Excluded from the default `npx hardhat test` run via EXCLUDED_EDGE_TESTS in hardhat.config.js.
 * Invoke explicitly:
 *   npx hardhat test test/contracts/Overtime/Casino/ThreeCardPokerEdgeSim.js
 */

const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('5000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;

const SIM_ROUNDS = 100_000;
const VALIDATION_ROUNDS = 50;
const ANTE_AMOUNT = 3n * USDC_UNIT;
const PAIR_PLUS_AMOUNT = 3n * USDC_UNIT;

// Card encoding mirrors the contract: card = 0..51, suit = card / 13, rank = card % 13
const DECK_SIZE = 52;
const CARDS_PER_HAND = 3;

const HandClass = {
	HIGH_CARD: 0,
	PAIR: 1,
	FLUSH: 2,
	STRAIGHT: 3,
	THREE_OF_A_KIND: 4,
	STRAIGHT_FLUSH: 5,
};
const Outcome = {
	NONE: 0,
	FOLDED: 1,
	DEALER_NOT_QUALIFIED: 2,
	PLAYER_WIN: 3,
	DEALER_WIN: 4,
	TIE: 5,
};

// JS mirror of the contract's _partialFisherYates.
function partialFisherYates(deck, n, word) {
	const d = [...deck];
	let cursor = BigInt(word);
	const MASK = 0xffffn;
	const SHIFT = 16n;
	const out = [];
	for (let i = 0; i < n; i++) {
		const remaining = BigInt(d.length - i);
		const j = i + Number((cursor & MASK) % remaining);
		cursor >>= SHIFT;
		[d[i], d[j]] = [d[j], d[i]];
		out.push(d[i]);
	}
	return out;
}
function fullDeck() {
	return Array.from({ length: DECK_SIZE }, (_, i) => i);
}
function deckExcluding(excluded) {
	const set = new Set(excluded);
	return fullDeck().filter((c) => !set.has(c));
}
function dealPlayer(word) {
	return partialFisherYates(fullDeck(), CARDS_PER_HAND, word);
}
function dealDealer(word, playerCards) {
	return partialFisherYates(deckExcluding(playerCards), CARDS_PER_HAND, word);
}

function rankOf(card) {
	return (card % 13) + 2;
}
function suitOf(card) {
	return Math.floor(card / 13);
}

function evaluate3Card(cards) {
	const ranks = cards.map(rankOf).sort((a, b) => b - a);
	const [hi, mid, lo] = ranks;
	const suits = cards.map(suitOf);
	const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
	let isStraight = false;
	let topRank = hi;
	if (hi - lo === 2 && hi - mid === 1) isStraight = true;
	else if (hi === 14 && mid === 3 && lo === 2) {
		isStraight = true;
		topRank = 3;
	}
	if (hi === lo) return { class_: HandClass.THREE_OF_A_KIND, top: hi, ranks: [hi] };
	if (isStraight && isFlush) return { class_: HandClass.STRAIGHT_FLUSH, top: topRank };
	if (isStraight) return { class_: HandClass.STRAIGHT, top: topRank };
	if (isFlush) return { class_: HandClass.FLUSH, top: hi, mid, lo };
	if (hi === mid) return { class_: HandClass.PAIR, pairRank: hi, kicker: lo };
	if (mid === lo) return { class_: HandClass.PAIR, pairRank: mid, kicker: hi };
	return { class_: HandClass.HIGH_CARD, top: hi, mid, lo };
}

function tieBreakerForCompare(ev) {
	if (ev.class_ === HandClass.STRAIGHT_FLUSH || ev.class_ === HandClass.STRAIGHT) return ev.top;
	if (ev.class_ === HandClass.THREE_OF_A_KIND) return ev.top;
	if (ev.class_ === HandClass.FLUSH) return (ev.top << 16) | (ev.mid << 8) | ev.lo;
	if (ev.class_ === HandClass.PAIR) return (ev.pairRank << 8) | ev.kicker;
	return (ev.top << 16) | (ev.mid << 8) | ev.lo; // HIGH_CARD
}

function compareHands(pEv, dEv) {
	if (pEv.class_ > dEv.class_) return 1;
	if (pEv.class_ < dEv.class_) return -1;
	const pt = tieBreakerForCompare(pEv);
	const dt = tieBreakerForCompare(dEv);
	if (pt > dt) return 1;
	if (pt < dt) return -1;
	return 0;
}

function dealerQualifies(dCards) {
	const ev = evaluate3Card(dCards);
	if (ev.class_ > HandClass.HIGH_CARD) return true;
	const top = Math.max(...dCards.map(rankOf));
	return top >= 12; // Q-high
}

// Optimal player strategy for TCP: Play with Q-6-4 or better, otherwise Fold
function shouldPlay(pCards) {
	const ev = evaluate3Card(pCards);
	if (ev.class_ > HandClass.HIGH_CARD) return true;
	// HIGH_CARD: compare against Q-6-4 (12-6-4)
	if (ev.top > 12) return true;
	if (ev.top < 12) return false;
	// top == Q
	if (ev.mid > 6) return true;
	if (ev.mid < 6) return false;
	// top == Q, mid == 6
	return ev.lo >= 4;
}

function anteBonusMultiplier(class_) {
	if (class_ === HandClass.STRAIGHT_FLUSH) return 5;
	if (class_ === HandClass.THREE_OF_A_KIND) return 4;
	if (class_ === HandClass.STRAIGHT) return 1;
	return 0;
}
function pairPlusMultiplier(class_) {
	if (class_ === HandClass.STRAIGHT_FLUSH) return 40;
	if (class_ === HandClass.THREE_OF_A_KIND) return 30;
	if (class_ === HandClass.STRAIGHT) return 6;
	if (class_ === HandClass.FLUSH) return 4;
	if (class_ === HandClass.PAIR) return 1;
	return 0;
}

/**
 * Simulate one round of TCP.
 * @param dealWord  256-bit BigInt VRF word for VRF1
 * @param resolveWord 256-bit BigInt VRF word for VRF2 (used only if Play)
 * @param ante  Number/BigInt ante stake
 * @param pp Number/BigInt pair-plus stake
 * @returns {object} stats for this round
 */
function simulateRound(dealWord, resolveWord, ante, pp) {
	const pCards = dealPlayer(dealWord);
	const pEv = evaluate3Card(pCards);

	// Pair Plus settles independently of dealer/fold
	const ppMult = pairPlusMultiplier(pEv.class_);
	// Match contract: pay 0 on loss (ppMult == 0); pay stake * (1 + mult) on a win
	const ppPayout = pp > 0n && ppMult > 0 ? BigInt(pp) * BigInt(1 + ppMult) : 0n;
	// Pair Plus net P&L for house = stake - payout (positive when house won, negative when player won)
	const ppHouseDelta = BigInt(pp) - ppPayout;

	const willPlay = shouldPlay(pCards);
	if (!willPlay) {
		// Fold: ante forfeit (full house gain), no Play stake
		return {
			pCards,
			dCards: null,
			pEv,
			dEv: null,
			outcome: Outcome.FOLDED,
			anteWagered: BigInt(ante),
			playWagered: 0n,
			ppWagered: BigInt(pp),
			anteHouseDelta: BigInt(ante),
			playHouseDelta: 0n,
			anteBonusHouseDelta: 0n,
			ppHouseDelta,
			totalHouseDelta: BigInt(ante) + ppHouseDelta,
			totalWagered: BigInt(ante) + BigInt(pp),
		};
	}

	// Play branch: VRF2 fulfills, dealer dealt, settle ante/play/bonus
	const dCards = dealDealer(resolveWord, pCards);
	const dEv = evaluate3Card(dCards);
	const playStake = BigInt(ante);

	// Ante Bonus: paid because player chose Play (regardless of dealer)
	const abMult = anteBonusMultiplier(pEv.class_);
	const abPayout = BigInt(ante) * BigInt(abMult); // pure bonus, no stake-back
	const abHouseDelta = -abPayout; // pure house loss when paid

	let outcome, anteAndPlayPayout;
	if (!dealerQualifies(dCards)) {
		// Ante 1:1, Play push: payout = 2*ante (ante stake-back + 1:1 win) + ante (Play stake-back) = 3*ante
		outcome = Outcome.DEALER_NOT_QUALIFIED;
		anteAndPlayPayout = BigInt(ante) * 3n;
	} else {
		const cmp = compareHands(pEv, dEv);
		if (cmp > 0) {
			outcome = Outcome.PLAYER_WIN;
			anteAndPlayPayout = BigInt(ante) * 4n; // ante 2x + play 2x
		} else if (cmp < 0) {
			outcome = Outcome.DEALER_WIN;
			anteAndPlayPayout = 0n;
		} else {
			outcome = Outcome.TIE;
			anteAndPlayPayout = BigInt(ante) * 2n; // both push
		}
	}

	// House delta on ante+play side = stake_in - payout = (ante + play) - anteAndPlayPayout
	const anteAndPlayHouseDelta = BigInt(ante) + playStake - anteAndPlayPayout;

	return {
		pCards,
		dCards,
		pEv,
		dEv,
		outcome,
		anteWagered: BigInt(ante),
		playWagered: playStake,
		ppWagered: BigInt(pp),
		anteHouseDelta: anteAndPlayHouseDelta + abHouseDelta, // combined ante side (ante+play+bonus) for the gauge
		playHouseDelta: 0n, // tracked inside anteHouseDelta — kept for symmetry / future split
		anteBonusHouseDelta: abHouseDelta,
		ppHouseDelta,
		totalHouseDelta: anteAndPlayHouseDelta + abHouseDelta + ppHouseDelta,
		totalWagered: BigInt(ante) + playStake + BigInt(pp),
	};
}

// Build a 256-bit-ish word from a numeric seed
function wordFromSeed(seed) {
	return BigInt('0x' + ethers.id(`tcp-sim-${seed}`).slice(2));
}

/* ========== HARDHAT FIXTURE — used only for cross-validation ========== */

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, freeBetsHolderStub] =
		await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
	const usdcAddr = await usdc.getAddress();
	const wethAddr = await weth.getAddress();
	const overAddr = await over.getAddress();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddr, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddr, OVER_PRICE);
	const priceFeedAddr = await priceFeed.getAddress();

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
			priceFeed: priceFeedAddr,
			vrfCoordinator: await vrf.getAddress(),
			freeBetsHolder: freeBetsHolderStub.address,
			referrals: ethers.ZeroAddress,
		},
		{
			usdc: usdcAddr,
			weth: wethAddr,
			over: overAddr,
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

	const TCP = await ethers.getContractFactory('ThreeCardPoker');
	const tcp = await upgrades.deployProxy(TCP, [], { initializer: false });
	const tcpAddr = await tcp.getAddress();
	await tcp.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(tcpAddr);

	// Fund treasury and player generously for the validation phase
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 800n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	// Lift circuit breaker for validation runs (we expect player to win sometimes)
	await core.connect(riskManager).setMaxNetLossPerGameUsd(tcpAddr, ethers.parseEther('100000'));

	return { tcp, tcpAddr, vrf, core, coreAddr, usdc, usdcAddr, owner, player };
}

async function placeAndDeal(ctx, dealWord) {
	const { tcp, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await tcp
		.connect(player)
		.placeBet(usdcAddr, ANTE_AMOUNT, PAIR_PLUS_AMOUNT, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return tcp.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	const reqId = placed.args.requestId;
	await vrf.fulfillRandomWords(coreAddr, reqId, [dealWord]);
	return betId;
}

async function playAndResolveContract(ctx, betId, resolveWord) {
	const { tcp, vrf, coreAddr, player } = ctx;
	const tx = await tcp.connect(player).play(betId);
	const receipt = await tx.wait();
	const played = receipt.logs
		.map((l) => {
			try {
				return tcp.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'PlayChosen');
	await vrf.fulfillRandomWords(coreAddr, played.args.requestId, [resolveWord]);
}

/* ========== TESTS ========== */

describe('ThreeCardPoker — edge sim & EVM cross-validation', function () {
	this.timeout(600_000); // 10 min cap; sim itself is sub-minute

	it(`cross-validates JS sim vs on-chain logic across ${VALIDATION_ROUNDS} rounds`, async () => {
		const ctx = await loadFixture(deployFixture);
		const { tcp, player } = ctx;

		for (let i = 0; i < VALIDATION_ROUNDS; i++) {
			const dealWord = wordFromSeed(`deal-${i}`);
			const resolveWord = wordFromSeed(`resolve-${i}`);
			const expected = simulateRound(dealWord, resolveWord, ANTE_AMOUNT, PAIR_PLUS_AMOUNT);

			const betId = await placeAndDeal(ctx, dealWord);
			// verify JS predicted player cards match contract
			const cards = await tcp.getBetCards(betId);
			expect(Number(cards.playerCards[0])).to.equal(expected.pCards[0]);
			expect(Number(cards.playerCards[1])).to.equal(expected.pCards[1]);
			expect(Number(cards.playerCards[2])).to.equal(expected.pCards[2]);

			if (expected.outcome === Outcome.FOLDED) {
				await tcp.connect(player).fold(betId);
			} else {
				await playAndResolveContract(ctx, betId, resolveWord);
				const cards2 = await tcp.getBetCards(betId);
				expect(Number(cards2.dealerCards[0])).to.equal(expected.dCards[0]);
				expect(Number(cards2.dealerCards[1])).to.equal(expected.dCards[1]);
				expect(Number(cards2.dealerCards[2])).to.equal(expected.dCards[2]);
			}

			const base = await tcp.getBetBase(betId);
			expect(Number(base.outcome)).to.equal(expected.outcome);

			// Cross-check payouts: PP, Ante Bonus, Ante+Play, total
			const payouts = await tcp.getBetPayouts(betId);
			const ppMultExp = pairPlusMultiplier(expected.pEv.class_);
			const expectedPp =
				PAIR_PLUS_AMOUNT > 0n && ppMultExp > 0 ? PAIR_PLUS_AMOUNT * BigInt(1 + ppMultExp) : 0n;
			expect(payouts.pairPlusPayout).to.equal(expectedPp);

			if (expected.outcome === Outcome.FOLDED) {
				expect(payouts.anteBonusPayout).to.equal(0n);
				expect(payouts.anteAndPlayPayout).to.equal(0n);
			} else {
				const abExp = ANTE_AMOUNT * BigInt(anteBonusMultiplier(expected.pEv.class_));
				expect(payouts.anteBonusPayout).to.equal(abExp);
				let apExp;
				if (expected.outcome === Outcome.DEALER_NOT_QUALIFIED) apExp = ANTE_AMOUNT * 3n;
				else if (expected.outcome === Outcome.PLAYER_WIN) apExp = ANTE_AMOUNT * 4n;
				else if (expected.outcome === Outcome.TIE) apExp = ANTE_AMOUNT * 2n;
				else apExp = 0n;
				expect(payouts.anteAndPlayPayout).to.equal(apExp);
			}
		}
	});

	it(`runs ${SIM_ROUNDS.toLocaleString()} TCP rounds in JS and validates ≥2% edge`, async () => {
		let antePlusPlayWagered = 0n;
		let antePlusPlayHouseDelta = 0n; // includes Ante Bonus
		let pairPlusWagered = 0n;
		let pairPlusHouseDelta = 0n;
		let totalWagered = 0n;
		let totalHouseDelta = 0n;
		let foldCount = 0;
		let dnqCount = 0;
		let pwCount = 0;
		let dwCount = 0;
		let tieCount = 0;
		const pHandClassCounts = new Array(6).fill(0);

		for (let i = 0; i < SIM_ROUNDS; i++) {
			const dealWord = wordFromSeed(`s-${i}-d`);
			const resolveWord = wordFromSeed(`s-${i}-r`);
			const r = simulateRound(dealWord, resolveWord, ANTE_AMOUNT, PAIR_PLUS_AMOUNT);
			pHandClassCounts[r.pEv.class_]++;
			if (r.outcome === Outcome.FOLDED) foldCount++;
			else if (r.outcome === Outcome.DEALER_NOT_QUALIFIED) dnqCount++;
			else if (r.outcome === Outcome.PLAYER_WIN) pwCount++;
			else if (r.outcome === Outcome.DEALER_WIN) dwCount++;
			else if (r.outcome === Outcome.TIE) tieCount++;

			antePlusPlayWagered += r.anteWagered + r.playWagered;
			antePlusPlayHouseDelta += r.anteHouseDelta; // already includes ante bonus
			pairPlusWagered += r.ppWagered;
			pairPlusHouseDelta += r.ppHouseDelta;
			totalWagered += r.totalWagered;
			totalHouseDelta += r.totalHouseDelta;
		}

		const edgeAntePlay =
			Number((antePlusPlayHouseDelta * 1_000_000n) / antePlusPlayWagered) / 10_000; // %
		const edgePairPlus = Number((pairPlusHouseDelta * 1_000_000n) / pairPlusWagered) / 10_000;
		const edgeAntePerAnte =
			Number((antePlusPlayHouseDelta * 1_000_000n) / (BigInt(SIM_ROUNDS) * BigInt(ANTE_AMOUNT))) /
			10_000;
		const edgeBlended = Number((totalHouseDelta * 1_000_000n) / totalWagered) / 10_000;

		// Print summary BEFORE assertions so a failure still surfaces the breakdown
		const pct = (n) => ((100 * n) / SIM_ROUNDS).toFixed(3) + '%';
		console.log('');
		console.log('==== TCP 100k Monte Carlo summary ====');
		console.log(`Rounds: ${SIM_ROUNDS.toLocaleString()}`);
		console.log(
			`  Folded                : ${foldCount.toString().padStart(6)} (${pct(foldCount)})`
		);
		console.log(`  Dealer not qualified  : ${dnqCount.toString().padStart(6)} (${pct(dnqCount)})`);
		console.log(`  Player win            : ${pwCount.toString().padStart(6)} (${pct(pwCount)})`);
		console.log(`  Dealer win            : ${dwCount.toString().padStart(6)} (${pct(dwCount)})`);
		console.log(`  Tie                   : ${tieCount.toString().padStart(6)} (${pct(tieCount)})`);
		console.log(`Player hand class freq (theory % shown for comparison):`);
		const theory = ['74.39%', '16.94%', '4.96%', '3.26%', '0.235%', '0.217%'];
		const labels = ['HighCard', 'Pair    ', 'Flush   ', 'Straight', 'ThreeOfK', 'StFlush '];
		for (let i = 0; i < 6; i++) {
			console.log(
				`  ${labels[i]}: ${pHandClassCounts[i].toString().padStart(6)}  (${pct(
					pHandClassCounts[i]
				)} sim vs ${theory[i]} theory)`
			);
		}
		console.log('');
		console.log('Realized edges:');
		console.log(
			`  Ante+Play+Bonus / (Ante+Play) wagered : ${edgeAntePlay.toFixed(3)}%   (theory ~2.01%)`
		);
		console.log(
			`  Ante+Play+Bonus / Ante wagered        : ${edgeAntePerAnte.toFixed(3)}%   (theory ~3.37%)`
		);
		console.log(
			`  Pair Plus / PP wagered                : ${edgePairPlus.toFixed(3)}%   (theory ~2.32%)`
		);
		console.log(`  Combined / total wagered              : ${edgeBlended.toFixed(3)}%`);
		console.log('======================================');

		// Floor enforcement: every individual edge must clear 2% (within MC noise)
		expect(edgeAntePlay).to.be.gt(1.7); // theoretical 2.01%, allow ~15bps MC noise on 100k
		expect(edgePairPlus).to.be.gt(1.9); // theoretical 2.32%
	});
});
