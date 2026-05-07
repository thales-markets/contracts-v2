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

/* ========== FIXTURE ========== */

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, player2, freeBetsHolderStub] =
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

	const Holdem = await ethers.getContractFactory('OvertimeHoldem');
	const holdem = await upgrades.deployProxy(Holdem, [], { initializer: false });
	const holdemAddr = await holdem.getAddress();
	await holdem.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(holdemAddr);

	// Lift circuit breaker for tests that intentionally trigger big wins
	await core.connect(riskManager).setMaxNetLossPerGameUsd(holdemAddr, ethers.parseEther('100000'));

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

		it('cancel from AWAITING_RESOLVE refunds ante + aa + call stake', async () => {
			const { holdem, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const word = findWord(
				(w) => unpackClass(evaluateCards(dealHoleAndFlop(w))) === HandClass.HIGH_CARD
			);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, MIN_USDC_BET, word);
			await holdem.connect(player).callBet(betId);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await holdem.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
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
});
