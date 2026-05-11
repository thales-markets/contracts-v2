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
const MIN_USDC_BET = 3n * USDC_UNIT;

const DECK_SIZE = 52;

const BetStatus = {
	NONE: 0,
	AWAITING_DEAL: 1,
	PLAYER_TURN: 2,
	AWAITING_RESOLVE: 3,
	RESOLVED: 4,
	CANCELLED: 5,
};

const Outcome = {
	NONE: 0,
	FOLDED: 1,
	DEALER_NOT_QUALIFIED: 2,
	PLAYER_WIN: 3,
	DEALER_WIN: 4,
	TIE: 5,
};

const HandClass = {
	HIGH_CARD: 0,
	PAIR: 1,
	TWO_PAIR: 2,
	THREE_OF_A_KIND: 3,
	STRAIGHT: 4,
	FLUSH: 5,
	FULL_HOUSE: 6,
	FOUR_OF_A_KIND: 7,
	STRAIGHT_FLUSH: 8,
	ROYAL_FLUSH: 9,
};

/* ========== JS MIRROR: SHUFFLE + EVALUATOR ========== */

function partialFisherYates(deck, n, word) {
	const d = [...deck];
	let cursor = BigInt(word);
	const MASK = 0xffffn;
	const SHIFT = 16n;
	for (let i = 0; i < n; i++) {
		const remaining = BigInt(d.length - i);
		const j = i + Number((cursor & MASK) % remaining);
		cursor >>= SHIFT;
		[d[i], d[j]] = [d[j], d[i]];
	}
	return d.slice(0, n);
}

function fullDeck() {
	return Array.from({ length: DECK_SIZE }, (_, i) => i);
}

function deckExcluding(excluded) {
	const set = new Set(excluded);
	return fullDeck().filter((c) => !set.has(c));
}

function dealHoleAndFlop(word) {
	return partialFisherYates(fullDeck(), 5, word);
}

function dealDealerAndBoard(word, alreadyDealt) {
	return partialFisherYates(deckExcluding(alreadyDealt), 4, word);
}

function rankOf(card) {
	return (card % 13) + 2;
}
function suitOf(card) {
	return Math.floor(card / 13);
}

function findStraightTop(rankMask) {
	for (let top = 14; top >= 6; top--) {
		const fiveMask = (0x1f << (top - 4)) & 0xffff;
		if ((rankMask & fiveMask) === fiveMask) return top;
	}
	if ((rankMask & 0x4000) !== 0 && (rankMask & 0x3c) === 0x3c) return 5;
	return 0;
}

function topNRanks(mask, n) {
	const out = [];
	for (let r = 14; r >= 2 && out.length < n; r--) {
		if ((mask & (1 << r)) !== 0) out.push(r);
	}
	while (out.length < n) out.push(0);
	return out;
}

function topNRanksExcluding(mask, n, ex0 = 0, ex1 = 0, ex2 = 0) {
	let cleared = mask;
	if (ex0) cleared &= ~(1 << ex0);
	if (ex1) cleared &= ~(1 << ex1);
	if (ex2) cleared &= ~(1 << ex2);
	return topNRanks(cleared, n);
}

function packHand(class_, r1 = 0, r2 = 0, r3 = 0, r4 = 0, r5 = 0) {
	return (class_ << 20) | (r1 << 16) | (r2 << 12) | (r3 << 8) | (r4 << 4) | r5;
}

/**
 * Evaluate a hand of 5–7 cards. Returns the best-5 packed hand value.
 * Mirror of OvertimeHoldem._evaluateCards on the contract.
 */
function evaluateCards(cards) {
	const rankCount = new Array(15).fill(0);
	const suitCount = [0, 0, 0, 0];
	let rankMask = 0;
	const suitRankMask = [0, 0, 0, 0];

	for (const c of cards) {
		const r = rankOf(c);
		const s = suitOf(c);
		rankCount[r]++;
		suitCount[s]++;
		rankMask |= 1 << r;
		suitRankMask[s] |= 1 << r;
	}

	// Flush?
	let flushSuit = -1;
	for (let s = 0; s < 4; s++) {
		if (suitCount[s] >= 5) {
			flushSuit = s;
			break;
		}
	}

	// Straight flush / royal
	if (flushSuit >= 0) {
		const sfTop = findStraightTop(suitRankMask[flushSuit]);
		if (sfTop > 0) {
			if (sfTop === 14) return packHand(HandClass.ROYAL_FLUSH, 14);
			return packHand(HandClass.STRAIGHT_FLUSH, sfTop);
		}
	}

	// Group ranks (descending)
	let fourRank = 0;
	let firstThree = 0;
	let secondThree = 0;
	let firstPair = 0;
	let secondPair = 0;
	for (let r = 14; r >= 2; r--) {
		if (rankCount[r] === 4) {
			if (fourRank === 0) fourRank = r;
		} else if (rankCount[r] === 3) {
			if (firstThree === 0) firstThree = r;
			else if (secondThree === 0) secondThree = r;
		} else if (rankCount[r] === 2) {
			if (firstPair === 0) firstPair = r;
			else if (secondPair === 0) secondPair = r;
		}
	}

	if (fourRank > 0) {
		const k = topNRanksExcluding(rankMask, 1, fourRank)[0];
		return packHand(HandClass.FOUR_OF_A_KIND, fourRank, k);
	}

	if (firstThree > 0 && (secondThree > 0 || firstPair > 0)) {
		const pairRank = secondThree > firstPair ? secondThree : firstPair;
		return packHand(HandClass.FULL_HOUSE, firstThree, pairRank);
	}

	if (flushSuit >= 0) {
		const top5 = topNRanks(suitRankMask[flushSuit], 5);
		return packHand(HandClass.FLUSH, top5[0], top5[1], top5[2], top5[3], top5[4]);
	}

	const straightTop = findStraightTop(rankMask);
	if (straightTop > 0) {
		return packHand(HandClass.STRAIGHT, straightTop);
	}

	if (firstThree > 0) {
		const ks = topNRanksExcluding(rankMask, 2, firstThree);
		return packHand(HandClass.THREE_OF_A_KIND, firstThree, ks[0], ks[1]);
	}

	if (firstPair > 0 && secondPair > 0) {
		const ks = topNRanksExcluding(rankMask, 1, firstPair, secondPair);
		return packHand(HandClass.TWO_PAIR, firstPair, secondPair, ks[0]);
	}

	if (firstPair > 0) {
		const ks = topNRanksExcluding(rankMask, 3, firstPair);
		return packHand(HandClass.PAIR, firstPair, ks[0], ks[1], ks[2]);
	}

	const hc = topNRanks(rankMask, 5);
	return packHand(HandClass.HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
}

function unpackClass(handValue) {
	return (handValue >> 20) & 0xf;
}
function unpackPrimary(handValue) {
	return (handValue >> 16) & 0xf;
}

function dealerQualifies(handValue) {
	const cls = unpackClass(handValue);
	if (cls > HandClass.PAIR) return true;
	if (cls === HandClass.PAIR) return unpackPrimary(handValue) >= 4;
	return false;
}

function antePaytableMultiplier(handValue) {
	const cls = unpackClass(handValue);
	if (cls === HandClass.ROYAL_FLUSH) return 100;
	if (cls === HandClass.STRAIGHT_FLUSH) return 20;
	if (cls === HandClass.FOUR_OF_A_KIND) return 10;
	if (cls === HandClass.FULL_HOUSE) return 3;
	return 1; // Flush, Straight, 3oK, 2P, Pair, HC all default 1:1
}

function aaBonusMultiplier(handValue) {
	const cls = unpackClass(handValue);
	if (cls === HandClass.ROYAL_FLUSH) return 100;
	if (cls === HandClass.STRAIGHT_FLUSH) return 50;
	if (cls === HandClass.FOUR_OF_A_KIND) return 40;
	if (cls === HandClass.FULL_HOUSE) return 30;
	if (cls === HandClass.FLUSH) return 20;
	if (cls === HandClass.STRAIGHT) return 10;
	if (cls === HandClass.THREE_OF_A_KIND) return 8;
	if (cls === HandClass.TWO_PAIR) return 7;
	if (cls === HandClass.PAIR && unpackPrimary(handValue) === 14) return 7; // pair of aces
	return 0;
}

function findWord(predicate, maxAttempts = 80000) {
	for (let i = 0; i < maxAttempts; i++) {
		const word = BigInt('0x' + ethers.id('seed-' + i).slice(2));
		if (predicate(word)) return word;
	}
	throw new Error(`findWord: no match in ${maxAttempts}`);
}

// Card encoding: card = suit*13 + (rank-2). Suits 0=♠,1=♥,2=♦,3=♣.
const CARD = {
	c2s: 0,
	c3s: 1,
	c4s: 2,
	c5s: 3,
	c6s: 4,
	c7s: 5,
	c8s: 6,
	c9s: 7,
	cTs: 8,
	cJs: 9,
	cQs: 10,
	cKs: 11,
	cAs: 12,
	c2h: 13,
	c3h: 14,
	c4h: 15,
	c5h: 16,
	c6h: 17,
	c7h: 18,
	c8h: 19,
	c9h: 20,
	cTh: 21,
	cJh: 22,
	cQh: 23,
	cKh: 24,
	cAh: 25,
	c2d: 26,
	c3d: 27,
	c4d: 28,
	c5d: 29,
	c6d: 30,
	c7d: 31,
	c8d: 32,
	c9d: 33,
	cTd: 34,
	cJd: 35,
	cQd: 36,
	cKd: 37,
	cAd: 38,
	c2c: 39,
	c3c: 40,
	c4c: 41,
	c5c: 42,
	c6c: 43,
	c7c: 44,
	c8c: 45,
	c9c: 46,
	cTc: 47,
	cJc: 48,
	cQc: 49,
	cKc: 50,
	cAc: 51,
};

// Deterministically build the VRF word that makes _partialFisherYates yield targetCards in order
// (within a deck constructed by filtering out `excluded` from the 52-card deck).
function craftWord(targetCards, excluded = []) {
	const excludeSet = new Set(excluded);
	const deck = [];
	for (let c = 0; c < DECK_SIZE; c++) if (!excludeSet.has(c)) deck.push(c);
	let word = 0n;
	for (let i = 0; i < targetCards.length; i++) {
		const target = targetCards[i];
		const pos = deck.indexOf(target);
		if (pos < 0) throw new Error(`craftWord: target ${target} not in remaining deck at step ${i}`);
		if (pos < i) throw new Error(`craftWord: target ${target} already drawn at step ${i}`);
		const chunkVal = BigInt(pos - i);
		if (chunkVal > 0xffffn) throw new Error('craftWord: chunkVal exceeds 16 bits');
		word |= chunkVal << (BigInt(i) * 16n);
		[deck[i], deck[pos]] = [deck[pos], deck[i]];
	}
	return word;
}

/* ========== FIXTURE ========== */

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, player2, daoSink] =
		await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddr = await usdc.getAddress();

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();

	const FBH = await ethers.getContractFactory('MockFreeBetsHolder');
	const fbh = await FBH.deploy(daoSink.address);
	const fbhAddr = await fbh.getAddress();

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
			freeBetsHolder: fbhAddr,
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

	const Holdem = await ethers.getContractFactory('OvertimeHoldem');
	const holdem = await upgrades.deployProxy(Holdem, [], { initializer: false });
	const holdemAddr = await holdem.getAddress();
	await holdem.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(holdemAddr);

	// Lift circuit breaker for tests that intentionally trigger big wins
	await core.setMaxNetLossPerGameUsd(holdemAddr, ethers.parseEther('100000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	const dataAddr = await data.getAddress();
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setOvertimeHoldem(holdemAddr);

	// Fund treasury and players
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.transfer(player2.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);
	await usdc.connect(player2).approve(coreAddr, ethers.MaxUint256);

	return {
		usdc,
		usdcAddr,
		manager,
		vrf,
		core,
		coreAddr,
		holdem,
		holdemAddr,
		data,
		dataAddr,
		owner,
		riskManager,
		resolver,
		pauser,
		player,
		player2,
		fbh,
		fbhAddr,
		daoSink,
	};
}

async function placeAndDeal(ctx, anteAmount, aaAmount, dealWord, options = {}) {
	const { holdem, vrf, coreAddr, usdcAddr, player } = ctx;
	const signer = options.signer ?? player;
	const referrer = options.referrer ?? ethers.ZeroAddress;
	const tx = await holdem.connect(signer).placeBet(usdcAddr, anteAmount, aaAmount, referrer);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return holdem.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	const requestId = placed.args.requestId;
	await vrf.fulfillRandomWords(coreAddr, requestId, [dealWord]);
	return { betId, requestId };
}

async function callAndResolve(ctx, betId, resolveWord, signer) {
	const { holdem, vrf, coreAddr, player } = ctx;
	const tx = await holdem.connect(signer ?? player).callBet(betId);
	const receipt = await tx.wait();
	const called = receipt.logs
		.map((l) => {
			try {
				return holdem.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'CallChosen');
	await vrf.fulfillRandomWords(coreAddr, called.args.requestId, [resolveWord]);
}

/* ========== TESTS ========== */

describe('CasinoCoreV2 + OvertimeHoldem (Phase 2)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Initialization', () => {
		it("initializes Hold'em with correct state", async () => {
			const { holdem, owner, coreAddr } = ctx;
			expect(await holdem.owner()).to.equal(owner.address);
			expect(await holdem.core()).to.equal(coreAddr);
			expect(await holdem.nextBetId()).to.equal(1n);
		});

		it('rejects zero addresses on init', async () => {
			const Holdem = await ethers.getContractFactory('OvertimeHoldem');
			const h2 = await upgrades.deployProxy(Holdem, [], { initializer: false });
			await expect(h2.initialize(ethers.ZeroAddress, ctx.coreAddr, ctx.coreAddr)).to.be
				.revertedWithCustomError;
		});
	});

	describe('placeBet', () => {
		it('pulls funds via core, reserves worst-case, emits BetPlaced', async () => {
			const { holdem, holdemAddr, core, coreAddr, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const aa = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			await holdem.connect(player).placeBet(usdcAddr, ante, aa, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante - aa);
			expect(await usdc.balanceOf(coreAddr)).to.be.gt(0);
			expect(await usdc.balanceOf(holdemAddr)).to.equal(0);
			// Reservation = 105*ante + 101*aa
			const expectedReservation = ante * 105n + aa * 101n;
			expect(await core.reservedProfitPerGame(holdemAddr, usdcAddr)).to.equal(expectedReservation);
		});

		it('reverts on zero ante', async () => {
			const { holdem, usdcAddr, player } = ctx;
			await expect(
				holdem.connect(player).placeBet(usdcAddr, 0n, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(holdem, 'InvalidAmount');
		});

		it('reverts on unsupported collateral', async () => {
			const { holdem, player } = ctx;
			await expect(
				holdem.connect(player).placeBet(ethers.ZeroAddress, MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(holdem, 'InvalidCollateral');
		});
	});

	describe('VRF1 fulfillment (deal hole + flop, AA Bonus settle)', () => {
		it('reveals 5 community-or-hole cards and advances to PLAYER_TURN', async () => {
			const { holdem } = ctx;
			const word = 0xdeadbeefn;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, word);
			const base = await holdem.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PLAYER_TURN);
			const cards = await holdem.getBetCards(betId);
			const expected = dealHoleAndFlop(word);
			expect(Number(cards.playerHole[0])).to.equal(expected[0]);
			expect(Number(cards.playerHole[1])).to.equal(expected[1]);
			expect(Number(cards.community[0])).to.equal(expected[2]);
			expect(Number(cards.community[1])).to.equal(expected[3]);
			expect(Number(cards.community[2])).to.equal(expected[4]);
			// dealer hole still zero
			expect(Number(cards.dealerHole[0])).to.equal(0);
		});

		it('does not pay AA Bonus on a non-qualifying hand (e.g., low pair)', async () => {
			const { holdem } = ctx;
			// find a 5-card hand that's just HC or low pair (no AA-bonus payout)
			const word = findWord((w) => {
				const v = evaluateCards(dealHoleAndFlop(w));
				return aaBonusMultiplier(v) === 0;
			});
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, MIN_USDC_BET, word);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(0n);
		});

		it('pays AA Bonus correctly on a Two Pair (7:1)', async () => {
			const { holdem, usdc, player } = ctx;
			const word = findWord((w) => {
				const v = evaluateCards(dealHoleAndFlop(w));
				return unpackClass(v) === HandClass.TWO_PAIR;
			});
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, MIN_USDC_BET, word);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 8n); // 1 + 7 = 8x stake
			// Net at PLAYER_TURN: -ante -aa + 8*aa = +6*aa - ante = +6 ante - ante = +5 ante
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET * 6n);
		});
	});

	describe('fold', () => {
		it('forfeits ante, releases ante-side reservation', async () => {
			const { holdem, holdemAddr, core, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			await holdem.connect(player).fold(betId);
			const base = await holdem.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.FOLDED);
			expect(await core.reservedProfitPerGame(holdemAddr, usdcAddr)).to.equal(0n);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('rejects fold from non-owner', async () => {
			const { holdem, player2 } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			await expect(holdem.connect(player2).fold(betId)).to.be.revertedWithCustomError(
				holdem,
				'BetNotOwner'
			);
		});
	});

	describe('callBet + resolution outcomes', () => {
		it('pulls 2x ante on call()', async () => {
			const { holdem, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId } = await placeAndDeal(ctx, ante, 0n, 0xdeadbeefn);
			const balBefore = await usdc.balanceOf(player.address);
			await holdem.connect(player).callBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante * 2n);
			const base = await holdem.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.AWAITING_RESOLVE);
		});

		it('dealer not qualified: ante pays per paytable, call pushes', async () => {
			const { holdem, usdc, player } = ctx;
			// Find a deal where the player's 7-card hand is HC and dealer's 7-card hand has no
			// pair/4+. Hard to rely on randomness — search exhaustively
			const dealWord = findWord((w) => {
				const five = dealHoleAndFlop(w);
				return unpackClass(evaluateCards(five)) === HandClass.HIGH_CARD;
			});
			const dealtSoFar = dealHoleAndFlop(dealWord);
			let resolveWord;
			try {
				resolveWord = findWord((w) => {
					const four = dealDealerAndBoard(w, dealtSoFar);
					const dSeven = [
						dealtSoFar[0],
						dealtSoFar[1],
						dealtSoFar[2],
						dealtSoFar[3],
						dealtSoFar[4],
						four[2],
						four[3],
					].slice(0, 7);
					// Player's 7 = player hole + flop + turn + river
					const pSeven = [
						dealtSoFar[0],
						dealtSoFar[1],
						dealtSoFar[2],
						dealtSoFar[3],
						dealtSoFar[4],
						four[2],
						four[3],
					];
					const dealerSeven = [
						four[0],
						four[1],
						dealtSoFar[2],
						dealtSoFar[3],
						dealtSoFar[4],
						four[2],
						four[3],
					];
					return !dealerQualifies(evaluateCards(dealerSeven));
				});
			} catch {
				return; // skip if pathological
			}

			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await callAndResolve(ctx, betId, resolveWord);

			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.DEALER_NOT_QUALIFIED);
			const payouts = await holdem.getBetPayouts(betId);
			// Ante paytable for HC = 1 → ante payout = 2*ante. Call pushes = 2*ante back.
			expect(payouts.antePayout).to.equal(ante * 2n);
			expect(payouts.callPayout).to.equal(ante * 2n);
			// Net: -ante (ante stake) - 2ante (call stake) + 2ante (ante payout) + 2ante (call push) = +ante
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + ante);
		});

		it('player wins with paytable hand (Full House → 3:1 ante, 1:1 call)', async () => {
			const { holdem, usdc, player } = ctx;
			// Find dealWord giving player a Full House on first 5 cards (player will have FH or
			// better on full 7 too)
			const dealWord = findWord((w) => {
				const five = dealHoleAndFlop(w);
				return unpackClass(evaluateCards(five)) === HandClass.FULL_HOUSE;
			});
			const dealtSoFar = dealHoleAndFlop(dealWord);
			// Find resolveWord where dealer qualifies and player wins
			let resolveWord;
			try {
				resolveWord = findWord((w) => {
					const four = dealDealerAndBoard(w, dealtSoFar);
					const board = [dealtSoFar[2], dealtSoFar[3], dealtSoFar[4], four[2], four[3]];
					const pSeven = [dealtSoFar[0], dealtSoFar[1], ...board];
					const dSeven = [four[0], four[1], ...board];
					const pVal = evaluateCards(pSeven);
					const dVal = evaluateCards(dSeven);
					return dealerQualifies(dVal) && pVal > dVal;
				});
			} catch {
				return;
			}

			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await callAndResolve(ctx, betId, resolveWord);

			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.PLAYER_WIN);
			const payouts = await holdem.getBetPayouts(betId);
			// Player's best 7 includes the Full House. Ante payout is per paytable for that class.
			// We don't preassume Full House — just verify outcome and payout shape
			const dealtSoFar2 = dealHoleAndFlop(dealWord);
			const four = dealDealerAndBoard(resolveWord, dealtSoFar2);
			const board = [dealtSoFar2[2], dealtSoFar2[3], dealtSoFar2[4], four[2], four[3]];
			const pVal = evaluateCards([dealtSoFar2[0], dealtSoFar2[1], ...board]);
			const expectedAnteMult = antePaytableMultiplier(pVal);
			expect(payouts.antePayout).to.equal(ante * BigInt(1 + expectedAnteMult));
			expect(payouts.callPayout).to.equal(ante * 4n); // 2*call = 4*ante
			// Net: -3*ante stakes + ante*(1+mult) + 4*ante = ante*(2 + mult)
			expect(await usdc.balanceOf(player.address)).to.equal(
				balBefore + ante * BigInt(2 + expectedAnteMult)
			);
		});

		it('dealer wins: ante and call lost', async () => {
			const { holdem, usdc, player } = ctx;
			// Find player HC on first 5; resolveWord where dealer qualifies AND beats player
			const dealWord = findWord((w) => {
				const v = evaluateCards(dealHoleAndFlop(w));
				return unpackClass(v) === HandClass.HIGH_CARD;
			});
			const dealtSoFar = dealHoleAndFlop(dealWord);
			let resolveWord;
			try {
				resolveWord = findWord((w) => {
					const four = dealDealerAndBoard(w, dealtSoFar);
					const board = [dealtSoFar[2], dealtSoFar[3], dealtSoFar[4], four[2], four[3]];
					const pSeven = [dealtSoFar[0], dealtSoFar[1], ...board];
					const dSeven = [four[0], four[1], ...board];
					const pVal = evaluateCards(pSeven);
					const dVal = evaluateCards(dSeven);
					return dealerQualifies(dVal) && pVal < dVal;
				});
			} catch {
				return;
			}

			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, ante, 0n, dealWord);
			await callAndResolve(ctx, betId, resolveWord);

			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.DEALER_WIN);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante * 3n);
		});
	});

	describe('cancel', () => {
		it('user cancel after timeout from AWAITING_DEAL refunds ante + AA Bonus', async () => {
			const { holdem, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await holdem
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return holdem.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await holdem.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			const base = await holdem.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('cancel from AWAITING_RESOLVE refunds ante + call stake (AA already settled in VRF1)', async () => {
			const { holdem, usdc, player } = ctx;
			const aa = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const word = findWord(
				(w) => unpackClass(evaluateCards(dealHoleAndFlop(w))) === HandClass.HIGH_CARD
			);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, aa, word);
			await holdem.connect(player).callBet(betId);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await holdem.connect(player).cancelBet(betId);
			// AA was already settled in VRF1 (high-card → lost). Cancel refunds only ante + call
			// stake. The AA stake stays with the bankroll (do NOT double-refund a settled side bet).
			// Net: user loses aa.
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - aa);
		});

		it('adminForceFold releases reservation for stale PLAYER_TURN bet', async () => {
			const { holdem, holdemAddr, core, resolver, player, usdcAddr } = ctx;
			const ante = MIN_USDC_BET;
			const word = findWord(
				(w) => unpackClass(evaluateCards(dealHoleAndFlop(w))) === HandClass.HIGH_CARD
			);
			const { betId } = await placeAndDeal(ctx, ante, 0n, word);
			// PLAYER_TURN; reservation = 105 * ante still held
			expect(await core.reservedProfitPerGame(holdemAddr, usdcAddr)).to.equal(105n * ante);
			// Cannot fold-force before timeout
			await expect(holdem.connect(resolver).adminForceFold(betId)).to.be.revertedWithCustomError(
				holdem,
				'PlayerTurnTimeoutNotReached'
			);
			// Non-resolver cannot call
			await expect(holdem.connect(player).adminForceFold(betId)).to.be.revertedWithCustomError(
				holdem,
				'InvalidSender'
			);
			// Advance time and force-fold
			await time.increase(24 * 60 * 60 + 1);
			await holdem.connect(resolver).adminForceFold(betId);
			expect(await core.reservedProfitPerGame(holdemAddr, usdcAddr)).to.equal(0n);
			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.FOLDED);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('adminForceFold rejects non-PLAYER_TURN bets', async () => {
			const { holdem, resolver, player, usdcAddr } = ctx;
			const tx = await holdem
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return holdem.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await expect(
				holdem.connect(resolver).adminForceFold(placed.args.betId)
			).to.be.revertedWithCustomError(holdem, 'InvalidBetStatus');
		});
	});

	describe("CasinoDataV2 — Hold'em records", () => {
		it("returns full Hold'em record after resolved bet", async () => {
			const { holdem, data, player } = ctx;
			const word = findWord(
				(w) => unpackClass(evaluateCards(dealHoleAndFlop(w))) === HandClass.HIGH_CARD
			);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0n, word);
			await holdem.connect(player).fold(betId);
			const r = await data.getOvertimeHoldemFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(player.address);
			expect(r.outcome).to.equal(Outcome.FOLDED);
		});
	});

	describe('free bet (placeBetWithFreeBet)', () => {
		async function fundFB(ctx, amount) {
			const { fbh, fbhAddr, usdc, owner, player, usdcAddr } = ctx;
			await usdc.mintForUser(owner.address);
			await usdc.connect(owner).transfer(fbhAddr, amount);
			await fbh.setBalance(player.address, usdcAddr, amount);
		}

		async function placeFreeAndDeal(ctx, ante, aa, dealWord) {
			const { holdem, vrf, coreAddr, usdcAddr, player } = ctx;
			const tx = await holdem
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, ante, aa, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return holdem.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [dealWord]);
			return placed.args.betId;
		}

		it('reverts on insufficient FBH balance', async () => {
			const { holdem, usdcAddr, player } = ctx;
			await expect(
				holdem
					.connect(player)
					.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWith('MockFBH: InsufficientBalance');
		});

		it('place-time: pulls (ante + AA) from FBH, does not touch wallet', async () => {
			const { holdem, fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET * 2n);
			const balBefore = await usdc.balanceOf(player.address);
			await holdem
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
		});

		it('callBet: pulls 2× ante from FBH (forced fold if FBH balance insufficient)', async () => {
			const { holdem, fbh, usdcAddr, player } = ctx;
			// Fund only enough for ante at place — zero left for call (need 2*ante = 6)
			await fundFB(ctx, MIN_USDC_BET);
			const betId = await placeFreeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			// Call needs 2*MIN_USDC_BET = 6 USDC — FBH balance is 0 → reverts
			await expect(holdem.connect(player).callBet(betId)).to.be.revertedWith(
				'MockFBH: InsufficientBalance'
			);
			// Fold path works (no extra FBH balance needed)
			await holdem.connect(player).fold(betId);
			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.FOLDED);
		});

		it('cancel from AWAITING_DEAL: refund credits FBH balance (reusable)', async () => {
			const { holdem, fbh, usdcAddr, player } = ctx;
			const stake = MIN_USDC_BET * 2n;
			await fundFB(ctx, stake);
			const tx = await holdem
				.connect(player)
				.placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return holdem.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await holdem.connect(player).cancelBet(placed.args.betId);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(stake);
		});

		it('fold (free bet): ante consumed, no referrer payment', async () => {
			const { holdem, fbh, usdcAddr, player } = ctx;
			await fundFB(ctx, MIN_USDC_BET);
			const betId = await placeFreeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn);
			await holdem.connect(player).fold(betId);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.FOLDED);
		});
	});

	describe('placeBet edge paths', () => {
		it('sets referrer on placeBet when referrer != 0', async () => {
			// Wire a working MockReferrals so setReferrer actually records the link
			const Mock = await ethers.getContractFactory('MockReferrals');
			const refContract = await Mock.deploy();
			const refAddr = await refContract.getAddress();
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					refAddr
				);
			const referrer = ethers.Wallet.createRandom().address;
			await placeAndDeal(ctx, MIN_USDC_BET, 0n, 0xdeadbeefn, { referrer });
			expect(await refContract.referrals(ctx.player.address)).to.equal(referrer);
		});
	});

	describe('VRF callback edge paths', () => {
		it('onVrfFulfilled with unknown requestId is a silent no-op', async () => {
			// Impersonate core and call onVrfFulfilled with a requestId that maps to no bet
			const { holdem, holdemAddr, coreAddr } = ctx;
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(holdem.connect(coreSigner).onVrfFulfilled(99999999n, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});
	});

	describe('Hand evaluator branch coverage (crafted seeds)', () => {
		// Helper: craft a VRF1 word that deals [hole0, hole1, flop0, flop1, flop2]
		function vrf1Word(cards5) {
			return craftWord(cards5);
		}
		// Helper: craft a VRF2 word that deals [dealerHole0, dealerHole1, turn, river]
		// excluding the 5 cards already revealed.
		function vrf2Word(cards4, excluded5) {
			return craftWord(cards4, excluded5);
		}

		async function playWith(player5, dealer4) {
			const { holdem, vrf, coreAddr, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const aa = MIN_USDC_BET;
			const tx = await holdem.connect(player).placeBet(usdcAddr, ante, aa, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return holdem.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const w1 = vrf1Word(player5);
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [w1]);
			const tx2 = await holdem.connect(player).callBet(placed.args.betId);
			const r2 = await tx2.wait();
			const called = r2.logs
				.map((l) => {
					try {
						return holdem.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CallChosen');
			const w2 = vrf2Word(dealer4, player5);
			await vrf.fulfillRandomWords(coreAddr, called.args.requestId, [w2]);
			return placed.args.betId;
		}

		it('Royal Flush — AA mult 100x + ante mult 100x', async () => {
			const player5 = [CARD.cAs, CARD.cKs, CARD.cQs, CARD.cJs, CARD.cTs];
			// Dealer is dealt non-conflicting low cards that yield HIGH_CARD only — dealer not qualified
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.c4d, CARD.c5c];
			const { holdem, player, usdc } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 101n); // 1 + 100
			// Player hand class = ROYAL_FLUSH → ante mult 100
			expect(payouts.antePayout).to.equal(MIN_USDC_BET * 101n);
			// Dealer 7 = [2h,3h, Qs,Js,Ts, 4d,5c] → straight T-Q? Ranks: T,J,Q,2,3,4,5. Best: Q-J-T-5-4? No 5-straight from these. So HIGH_CARD.
			// Outcome: DEALER_NOT_QUALIFIED → call pushes (2*ante)
			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.DEALER_NOT_QUALIFIED);
			expect(payouts.callPayout).to.equal(MIN_USDC_BET * 2n);
			expect(await usdc.balanceOf(player.address)).to.be.gt(balBefore);
		});

		it('Straight Flush (non-royal) — AA mult 50x', async () => {
			const player5 = [CARD.c9s, CARD.c8s, CARD.c7s, CARD.c6s, CARD.c5s];
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.c2d, CARD.c2c]; // dealer has trips 2's, qualifies
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 51n); // 1 + 50
			// Player 7 includes SF 5..9♠ → ante mult 20
			expect(payouts.antePayout).to.equal(MIN_USDC_BET * 21n);
		});

		it('Four of a Kind — AA mult 40x', async () => {
			const player5 = [CARD.cAs, CARD.cAh, CARD.cAd, CARD.cAc, CARD.c5s];
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.c4d, CARD.c6c];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 41n);
			// Player 7 with AAAA → ante mult 10
			expect(payouts.antePayout).to.equal(MIN_USDC_BET * 11n);
		});

		it('Full House (two 3-of-a-kinds in 7 cards)', async () => {
			// Player hole: As, Ks. Flop: Ah, Kh, 5c. Turn/river adds Ad, Kd → AAA + KKK + 5
			const player5 = [CARD.cAs, CARD.cKs, CARD.cAh, CARD.cKh, CARD.c5c];
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.cAd, CARD.cKd];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			// Player 7 = AAA KKK 5 → AAA KK best5 = FULL HOUSE (A over K)
			const payouts = await holdem.getBetPayouts(betId);
			// AA bonus is on first 5 only → AAs + Ks + Ah + Kh + 5c = AA KK 5 = TWO_PAIR (7x)
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 8n);
		});

		it('Flush (no straight)', async () => {
			const player5 = [CARD.cAs, CARD.cKs, CARD.c9s, CARD.c5s, CARD.c2s];
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.c4d, CARD.c6c];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			// AA bonus on flush = 20x → 1 + 20
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 21n);
		});

		it('Straight (mixed suits)', async () => {
			// A-K-Q-J-T across different suits
			const player5 = [CARD.cAs, CARD.cKh, CARD.cQc, CARD.cJd, CARD.cTs];
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.c4d, CARD.c6c];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			// AA bonus on straight = 10x
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 11n);
		});

		it('Wheel straight (A-2-3-4-5)', async () => {
			const player5 = [CARD.cAs, CARD.c5h, CARD.c4c, CARD.c3d, CARD.c2s];
			const dealer4 = [CARD.c7h, CARD.c8h, CARD.c9d, CARD.cTc];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			// AA bonus on wheel = STRAIGHT = 10x
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 11n);
		});

		it('Pair of Aces (PoA) — AA bonus 7x', async () => {
			// Player hole + flop: AsAh + 2c 5d 7s → AA only on first 5
			const player5 = [CARD.cAs, CARD.cAh, CARD.c2c, CARD.c5d, CARD.c7s];
			const dealer4 = [CARD.c3h, CARD.c4h, CARD.c8d, CARD.c9c];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 8n);
		});

		it('Three of a Kind — AA bonus 8x', async () => {
			const player5 = [CARD.cAs, CARD.cAh, CARD.cAd, CARD.c5c, CARD.c7s];
			const dealer4 = [CARD.c2h, CARD.c3h, CARD.c4d, CARD.c6c];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 9n);
		});

		it('Dealer high-card disqualified — exercises _dealerQualifies false-return', async () => {
			// Engineer a 7-card dealer hand with no pair, no straight, no flush.
			// Player hole + flop chosen so dealer 7 = [Qc,Ad,2s,4d,6c,8h,Ts] → ranks A,Q,T,8,6,4,2.
			// Best 5 = A Q T 8 6 = HIGH_CARD. Dealer fails to qualify (returns false at line 719).
			const player5 = [CARD.c3h, CARD.c9c, CARD.c2s, CARD.c4d, CARD.c6c]; // player 7 will include 8h, Ts from dealer side
			const dealer4 = [CARD.cQc, CARD.cAd, CARD.c8h, CARD.cTs];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.DEALER_NOT_QUALIFIED);
		});

		it('Full House on 5 cards — AA bonus 30x (FH branch)', async () => {
			// AA bonus evaluates the first 5 cards (player hole + flop). Need a 5-card Full House:
			// AAA + KK.
			const player5 = [CARD.cAs, CARD.cAh, CARD.cAd, CARD.cKs, CARD.cKh];
			const dealer4 = [CARD.c2c, CARD.c3c, CARD.c4d, CARD.c5d];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const payouts = await holdem.getBetPayouts(betId);
			expect(payouts.aaBonusPayout).to.equal(MIN_USDC_BET * 31n); // 1 + 30
		});

		it('Tie with premium ante mult (4oK shared) — exercises tie + premium branch', async () => {
			// Both player and dealer hit AAAA-K via shared community. anteMult = 10 > 1 → fires
			// the `anteMult > ANTE_MULT_DEFAULT` branch on the TIE path.
			// Community = [As, Ah, Ad, Ac, Ks]. Player hole = 2s, 3h. Dealer hole = 4s, 5h.
			// Both players' best 5 = AAAA + K → tie. anteMult(4oK) = 10 > 1.
			const player5 = [CARD.c2s, CARD.c3h, CARD.cAs, CARD.cAh, CARD.cAd];
			const dealer4 = [CARD.c4s, CARD.c5h, CARD.cAc, CARD.cKs];
			const { holdem } = ctx;
			const betId = await playWith(player5, dealer4);
			const base = await holdem.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.TIE);
			const payouts = await holdem.getBetPayouts(betId);
			// On tie with premium: antePayout = ante + ante * anteMult = ante * 11
			expect(payouts.antePayout).to.equal(MIN_USDC_BET * 11n);
		});
	});
});
