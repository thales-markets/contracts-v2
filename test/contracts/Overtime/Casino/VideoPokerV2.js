const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('100000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const MIN_USDC_BET = 3n * USDC_UNIT;

const DECK_SIZE = 52;
const HAND_SIZE = 5;

const BetStatus = {
	NONE: 0,
	AWAITING_DEAL: 1,
	PLAYER_TURN: 2,
	AWAITING_DRAW: 3,
	RESOLVED: 4,
	CANCELLED: 5,
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

const PAYTABLE = {
	[HandClass.ROYAL_FLUSH]: 800,
	[HandClass.STRAIGHT_FLUSH]: 50,
	[HandClass.FOUR_OF_A_KIND]: 25,
	[HandClass.FULL_HOUSE]: 8,
	[HandClass.FLUSH]: 5,
	[HandClass.STRAIGHT]: 4,
	[HandClass.THREE_OF_A_KIND]: 3,
	[HandClass.TWO_PAIR]: 2,
};

/* ========== JS MIRROR: deck + Fisher-Yates + 5-card evaluator ========== */

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
	// Wheel A-2-3-4-5
	if ((rankMask & 0x4000) !== 0 && (rankMask & 0x3c) === 0x3c) return 5;
	return 0;
}

/// Evaluate a 5-card hand. Returns { class_, primaryRank } where primaryRank is the rank of
/// the pair when class_ == PAIR (used for the Jacks-or-Better cut-off)
function evaluateFive(cards) {
	if (cards.length !== HAND_SIZE) throw new Error('expected 5 cards');
	const rankCount = new Array(15).fill(0);
	let rankMask = 0;
	let flush = true;
	const suit0 = suitOf(cards[0]);
	for (const c of cards) {
		const r = rankOf(c);
		rankCount[r]++;
		rankMask |= 1 << r;
		if (suitOf(c) !== suit0) flush = false;
	}

	const straightTop = findStraightTop(rankMask);

	if (flush && straightTop > 0) {
		if (straightTop === 14) return { class_: HandClass.ROYAL_FLUSH, primaryRank: 14 };
		return { class_: HandClass.STRAIGHT_FLUSH, primaryRank: straightTop };
	}

	let fourRank = 0;
	let threeRank = 0;
	let firstPair = 0;
	let secondPair = 0;
	for (let r = 14; r >= 2; r--) {
		const c = rankCount[r];
		if (c === 4) fourRank = r;
		else if (c === 3) threeRank = r;
		else if (c === 2) {
			if (!firstPair) firstPair = r;
			else if (!secondPair) secondPair = r;
		}
	}

	if (fourRank) return { class_: HandClass.FOUR_OF_A_KIND, primaryRank: fourRank };
	if (threeRank && firstPair) return { class_: HandClass.FULL_HOUSE, primaryRank: threeRank };
	if (flush) return { class_: HandClass.FLUSH, primaryRank: 14 };
	if (straightTop > 0) return { class_: HandClass.STRAIGHT, primaryRank: straightTop };
	if (threeRank) return { class_: HandClass.THREE_OF_A_KIND, primaryRank: threeRank };
	if (firstPair && secondPair) return { class_: HandClass.TWO_PAIR, primaryRank: firstPair };
	if (firstPair) return { class_: HandClass.PAIR, primaryRank: firstPair };
	return { class_: HandClass.HIGH_CARD, primaryRank: 0 };
}

function paytableMultiplier(class_, primaryRank) {
	if (class_ === HandClass.PAIR) return primaryRank >= 11 ? 1 : 0;
	if (PAYTABLE[class_] !== undefined) return PAYTABLE[class_];
	return 0;
}

/// Deal the initial 5 cards from a VRF word
function dealInitial(word) {
	return partialFisherYates(fullDeck(), HAND_SIZE, word);
}

/// Mirror of the contract's draw resolution: keep held cards, fill non-held from the remaining
/// 47-card deck (excluding all 5 initial cards) via partial Fisher-Yates
function applyDraw(initial, holdMask, drawWord) {
	const needed = HAND_SIZE - popcount(holdMask);
	const remainingDeck = deckExcluding(initial);
	const draws = needed > 0 ? partialFisherYates(remainingDeck, needed, drawWord) : [];
	const final = new Array(HAND_SIZE);
	let cursor = 0;
	for (let i = 0; i < HAND_SIZE; i++) {
		if ((holdMask >> i) & 1) final[i] = initial[i];
		else {
			final[i] = draws[cursor++];
		}
	}
	return final;
}

function popcount(x) {
	let c = 0;
	while (x) {
		c += x & 1;
		x >>= 1;
	}
	return c;
}

/// Brute-force find a VRF word whose initial deal matches a predicate. Used to craft specific
/// hands without trying to invert the Fisher-Yates shuffle. Same pattern as KenoV2.js
function findWord(prefix, predicate, maxIter = 500000) {
	for (let i = 0; i < maxIter; i++) {
		const w = BigInt(ethers.id(`${prefix}-${i}`));
		const cards = dealInitial(w);
		if (predicate(cards)) return w;
	}
	throw new Error(`findWord: no match in ${maxIter} iterations for ${prefix}`);
}

/// Find a (dealWord, drawWord) so the FINAL hand after applying `holdMask` to the dealt
/// initial hand satisfies `finalPredicate`. Optionally constrains the initial deal via
/// `dealPredicate` (useful for rare final hands — search for a "good seed" initial then
/// brute-force the draw). Combined search-space is `maxDeal * maxDraw`
function findDealAndDraw(
	prefix,
	holdMask,
	finalPredicate,
	dealPredicate = null,
	maxDeal = 500000,
	maxDraw = 200
) {
	for (let i = 0; i < maxDeal; i++) {
		const dealWord = BigInt(ethers.id(`${prefix}-deal-${i}`));
		const initial = dealInitial(dealWord);
		if (dealPredicate && !dealPredicate(initial)) continue;
		for (let j = 0; j < maxDraw; j++) {
			const drawWord = BigInt(ethers.id(`${prefix}-draw-${i}-${j}`));
			const final = applyDraw(initial, holdMask, drawWord);
			if (finalPredicate(final)) return { dealWord, drawWord, initial, final };
		}
	}
	throw new Error(`findDealAndDraw: no match for ${prefix} hold=${holdMask}`);
}

/* ========== FIXTURE ========== */

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, daoSink] = await ethers.getSigners();

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

	const VP = await ethers.getContractFactory('VideoPoker');
	const vp = await upgrades.deployProxy(VP, [], { initializer: false });
	const vpAddr = await vp.getAddress();
	await vp.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(vpAddr);
	await core.setMaxNetLossPerGameUsd(vpAddr, ethers.parseEther('1000000'));

	await usdc.mintForUser(owner.address);
	// Reservation per bet = 801x stake = $2403 at $3 ante. Seed core with enough to cover a
	// few sequential reservations plus payouts. Owner starts with 100 + 5000 = 5100 eUSDC
	await usdc.transfer(coreAddr, 4_500n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		vp,
		vpAddr,
		vrf,
		core,
		coreAddr,
		usdc,
		usdcAddr,
		fbh,
		fbhAddr,
		daoSink,
		owner,
		riskManager,
		resolver,
		pauser,
		player,
	};
}

/* ========== HELPERS ========== */

function parseBetPlaced(ctx, receipt) {
	return receipt.logs
		.map((l) => {
			try {
				return ctx.vp.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
}

function parseDrawRequested(ctx, receipt) {
	return receipt.logs
		.map((l) => {
			try {
				return ctx.vp.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'DrawRequested');
}

async function placeAndDeal(ctx, amount, dealWord) {
	const { vp, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await vp.connect(player).placeBet(usdcAddr, amount, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = parseBetPlaced(ctx, receipt);
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [dealWord]);
	return { betId: placed.args.betId, requestId: placed.args.requestId };
}

async function drawAndResolve(ctx, betId, holdMask, drawWord) {
	const { vp, vrf, coreAddr, player } = ctx;
	const tx = await vp.connect(player).draw(betId, holdMask);
	const receipt = await tx.wait();
	const drawEv = parseDrawRequested(ctx, receipt);
	await vrf.fulfillRandomWords(coreAddr, drawEv.args.requestId, [drawWord]);
	return drawEv;
}

/* ========== TESTS ========== */

describe('VideoPoker (Jacks or Better, 8/5)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Defaults', () => {
		it('exposes constants', async () => {
			const { vp } = ctx;
			expect(await vp.MIN_BET_USD()).to.equal(ethers.parseEther('3'));
		});
	});

	describe('placeBet validation', () => {
		it('rejects zero amount', async () => {
			const { vp, usdcAddr, player } = ctx;
			await expect(
				vp.connect(player).placeBet(usdcAddr, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(vp, 'InvalidAmount');
		});

		it('rejects unsupported collateral', async () => {
			const { vp, player } = ctx;
			await expect(
				vp.connect(player).placeBet(ethers.ZeroAddress, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(vp, 'InvalidCollateral');
		});

		it('rejects bet below MIN_BET_USD', async () => {
			const { vp, usdcAddr, player } = ctx;
			await expect(
				vp.connect(player).placeBet(usdcAddr, USDC_UNIT, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(vp, 'InvalidAmount');
		});

		it('soft-caps reservation when effectiveMaxProfit < 800x stake', async () => {
			// Tighten profit cap to $100. With $3 ante, worst-case profit = 800×3 = $2400 USD.
			// Cap truncates reservation to stake + cap-in-collateral = 3 + 100 = 103 USDC. Bet
			// placement succeeds; payout at resolve is truncated to stake + cap.
			const { vp, core, usdcAddr, player, vpAddr } = ctx;
			await core.setRiskParams(ethers.parseEther('100'), 0);
			await expect(vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)).to.not
				.be.reverted;
			expect(await core.reservedProfitPerGame(vpAddr, usdcAddr)).to.equal(
				MIN_USDC_BET + 100n * USDC_UNIT
			);
		});
	});

	describe('placeBet happy path', () => {
		it('pulls stake, reserves 801x, dispatches VRF, sets AWAITING_DEAL', async () => {
			const { vp, vpAddr, core, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = parseBetPlaced(ctx, receipt);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
			expect(await core.reservedProfitPerGame(vpAddr, usdcAddr)).to.equal(801n * MIN_USDC_BET);
			const base = await vp.getBetBase(placed.args.betId);
			expect(base.status).to.equal(BetStatus.AWAITING_DEAL);
			expect(base.amount).to.equal(MIN_USDC_BET);
		});

		it('VRF1 advances to PLAYER_TURN and reveals 5 unique cards', async () => {
			const { vp } = ctx;
			const dealWord = 0x123456789abcdefn;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, dealWord);
			const base = await vp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PLAYER_TURN);
			const { initialCards } = await vp.getBetCards(betId);
			const seen = new Set();
			for (let i = 0; i < HAND_SIZE; i++) {
				expect(Number(initialCards[i])).to.be.lessThan(52);
				seen.add(Number(initialCards[i]));
			}
			expect(seen.size).to.equal(HAND_SIZE);
			// Confirm JS mirror matches contract
			const expected = dealInitial(dealWord);
			for (let i = 0; i < HAND_SIZE; i++) {
				expect(Number(initialCards[i])).to.equal(expected[i]);
			}
		});
	});

	describe('draw validation', () => {
		it('rejects from non-PLAYER_TURN (still AWAITING_DEAL)', async () => {
			const { vp, vpAddr, usdcAddr, player } = ctx;
			const tx = await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = parseBetPlaced(ctx, receipt);
			await expect(vp.connect(player).draw(placed.args.betId, 0)).to.be.revertedWithCustomError(
				vp,
				'InvalidBetStatus'
			);
		});

		it('rejects non-owner', async () => {
			const { vp, owner } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await expect(vp.connect(owner).draw(betId, 0)).to.be.revertedWithCustomError(
				vp,
				'BetNotOwner'
			);
		});

		it('rejects holdMask > 31', async () => {
			const { vp, player } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await expect(vp.connect(player).draw(betId, 32)).to.be.revertedWithCustomError(
				vp,
				'InvalidHoldMask'
			);
			await expect(vp.connect(player).draw(betId, 64)).to.be.revertedWithCustomError(
				vp,
				'InvalidHoldMask'
			);
		});
	});

	describe('draw happy paths', () => {
		it('holdMask=0b11111 keeps all 5 cards and resolves on the initial hand', async () => {
			const { vp } = ctx;
			const dealWord = 0xdeadbeefn;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, dealWord);
			await drawAndResolve(ctx, betId, 31, 0x12345n);
			const { initialCards, finalCards } = await vp.getBetCards(betId);
			for (let i = 0; i < HAND_SIZE; i++) {
				expect(Number(finalCards[i])).to.equal(Number(initialCards[i]));
			}
			const base = await vp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('holdMask=0 discards all 5 and replaces from the 47-card remainder', async () => {
			const { vp } = ctx;
			const dealWord = 0xcafe0bab3n;
			const drawWord = 0xfeedface11n;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, dealWord);
			await drawAndResolve(ctx, betId, 0, drawWord);
			const { initialCards, finalCards } = await vp.getBetCards(betId);
			const initialSet = new Set();
			for (let i = 0; i < HAND_SIZE; i++) initialSet.add(Number(initialCards[i]));
			const finalSet = new Set();
			for (let i = 0; i < HAND_SIZE; i++) finalSet.add(Number(finalCards[i]));
			expect(finalSet.size).to.equal(HAND_SIZE);
			// None of the final cards should overlap the initial deal
			for (const c of finalSet) expect(initialSet.has(c)).to.equal(false);
			// JS mirror
			const expected = applyDraw(dealInitial(dealWord), 0, drawWord);
			for (let i = 0; i < HAND_SIZE; i++) {
				expect(Number(finalCards[i])).to.equal(expected[i]);
			}
		});
	});

	describe('Paytable coverage', () => {
		/// Resolve a bet whose FINAL hand (after holding `holdMask` and applying `drawWord`)
		/// satisfies `finalPredicate`, then assert payout matches the expected multiplier.
		/// Setting `holdMask = 31` means "hold everything, deal IS final"; any other mask drives
		/// a search over (dealWord, drawWord) pairs
		async function assertHandPays(
			prefix,
			holdMask,
			finalPredicate,
			expectedClass,
			expectedMult,
			dealPredicate = null
		) {
			const { vp, usdc, player } = ctx;
			let dealWord, drawWord;
			if (holdMask === 31) {
				dealWord = findWord(prefix, (cards) => {
					const ev = evaluateFive(cards);
					return finalPredicate(cards, ev);
				});
				drawWord = 0x1n;
			} else {
				const r = findDealAndDraw(
					prefix,
					holdMask,
					(final) => {
						const ev = evaluateFive(final);
						return finalPredicate(final, ev);
					},
					dealPredicate
				);
				dealWord = r.dealWord;
				drawWord = r.drawWord;
			}
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, dealWord);
			await drawAndResolve(ctx, betId, holdMask, drawWord);
			const base = await vp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(Number(base.handClass)).to.equal(expectedClass);
			expect(Number(base.multiplier)).to.equal(expectedMult);
			if (expectedMult > 0) {
				const expectedReturn = MIN_USDC_BET * BigInt(1 + expectedMult);
				expect(base.payout).to.equal(expectedReturn);
				expect(await usdc.balanceOf(player.address)).to.equal(
					balBefore - MIN_USDC_BET + expectedReturn
				);
			} else {
				expect(base.payout).to.equal(0n);
				expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
			}
		}

		// Wrapper for "hold all five" predicate-on-initial tests
		async function findFinalHandAndAssert(prefix, predicate, expectedClass, expectedMult) {
			return assertHandPays(prefix, 31, predicate, expectedClass, expectedMult);
		}

		it('Pair of Jacks pays 1:1', async () => {
			await findFinalHandAndAssert(
				'pair-jacks',
				(_, ev) => ev.class_ === HandClass.PAIR && ev.primaryRank === 11,
				HandClass.PAIR,
				1
			);
		});

		it('Pair of 10s pays 0 (below Jacks)', async () => {
			await findFinalHandAndAssert(
				'pair-tens',
				(_, ev) => ev.class_ === HandClass.PAIR && ev.primaryRank === 10,
				HandClass.PAIR,
				0
			);
		});

		it('Pair of 2s pays 0 (below Jacks)', async () => {
			await findFinalHandAndAssert(
				'pair-twos',
				(_, ev) => ev.class_ === HandClass.PAIR && ev.primaryRank === 2,
				HandClass.PAIR,
				0
			);
		});

		it('Two Pair pays 2:1', async () => {
			await findFinalHandAndAssert(
				'two-pair',
				(_, ev) => ev.class_ === HandClass.TWO_PAIR,
				HandClass.TWO_PAIR,
				2
			);
		});

		it('Three of a Kind pays 3:1', async () => {
			await findFinalHandAndAssert(
				'three-kind',
				(_, ev) => ev.class_ === HandClass.THREE_OF_A_KIND,
				HandClass.THREE_OF_A_KIND,
				3
			);
		});

		it('Straight pays 4:1', async () => {
			await findFinalHandAndAssert(
				'straight',
				(_, ev) => ev.class_ === HandClass.STRAIGHT,
				HandClass.STRAIGHT,
				4
			);
		});

		it('Wheel A-2-3-4-5 straight pays 4:1', async () => {
			await findFinalHandAndAssert(
				'wheel',
				(_, ev) => ev.class_ === HandClass.STRAIGHT && ev.primaryRank === 5,
				HandClass.STRAIGHT,
				4
			);
		});

		it('Flush pays 5:1', async () => {
			await findFinalHandAndAssert(
				'flush',
				(_, ev) => ev.class_ === HandClass.FLUSH,
				HandClass.FLUSH,
				5
			);
		});

		it('Full House pays 8:1', async () => {
			await findFinalHandAndAssert(
				'full-house',
				(_, ev) => ev.class_ === HandClass.FULL_HOUSE,
				HandClass.FULL_HOUSE,
				8
			);
		});

		it('Four of a Kind pays 25:1', async () => {
			await findFinalHandAndAssert(
				'four-kind',
				(_, ev) => ev.class_ === HandClass.FOUR_OF_A_KIND,
				HandClass.FOUR_OF_A_KIND,
				25
			);
		});

		it('Straight Flush pays 50:1', async () => {
			// SF is too rare (~1/72k) for brute-forcing the full deal. Instead, find a deal
			// where the first 4 cards are 4-to-a-straight-flush, hold those, and brute-force
			// the draw to land the 5th card
			const dealPredicate = (initial) => {
				const first4 = initial.slice(0, 4);
				if (new Set(first4.map(suitOf)).size !== 1) return false;
				const ranks = first4.map(rankOf).sort((a, b) => a - b);
				// Need 4 consecutive ranks, all ≤ K (so adding the next/prev rank gives a
				// non-Royal SF). E.g. 5-6-7-8 (add 4 or 9), 6-7-8-9, etc.
				for (let i = 1; i < 4; i++) {
					if (ranks[i] !== ranks[0] + i) return false;
				}
				// Exclude wheel A-2-3-4 (rare and tricky) and top T-J-Q-K (would be Royal)
				if (ranks[3] === 14) return false;
				if (ranks[0] === 14) return false;
				return true;
			};
			await assertHandPays(
				'sf',
				0b01111, // hold first 4
				(_, ev) => ev.class_ === HandClass.STRAIGHT_FLUSH,
				HandClass.STRAIGHT_FLUSH,
				50,
				dealPredicate
			);
		});

		it('Royal Flush pays 800:1', async () => {
			// Royal is 1/650k — completely infeasible by brute force. Use the 4-to-Royal
			// partial-hold strategy: find a deal with 4 of {T,J,Q,K,A} of the same suit in
			// the first 4 positions, hold them, then brute-force the draw to land the 5th
			const dealPredicate = (initial) => {
				const first4 = initial.slice(0, 4);
				if (new Set(first4.map(suitOf)).size !== 1) return false;
				const ranks = first4.map(rankOf).sort((a, b) => a - b);
				// Must be 4 of {10, J, Q, K, A} (ranks 10..14)
				for (const r of ranks) {
					if (r < 10) return false;
				}
				// Ensure all 4 are distinct ranks (always true since same suit + unique cards)
				return new Set(ranks).size === 4;
			};
			await assertHandPays(
				'royal',
				0b01111, // hold first 4
				(_, ev) => ev.class_ === HandClass.ROYAL_FLUSH,
				HandClass.ROYAL_FLUSH,
				800,
				dealPredicate
			);
		});

		it('High card loses (0 payout)', async () => {
			await findFinalHandAndAssert(
				'high-card',
				(_, ev) => ev.class_ === HandClass.HIGH_CARD,
				HandClass.HIGH_CARD,
				0
			);
		});
	});

	describe('Draw flow (partial hold)', () => {
		it('holdMask works for partial hold and final hand matches JS mirror', async () => {
			const { vp } = ctx;
			const dealWord = ethers.toBigInt(ethers.id('partial-hold-1'));
			const drawWord = ethers.toBigInt(ethers.id('partial-hold-1-draw'));
			const initial = dealInitial(dealWord);
			// Hold first and third card only
			const holdMask = 0b00101;
			const expectedFinal = applyDraw(initial, holdMask, drawWord);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, dealWord);
			await drawAndResolve(ctx, betId, holdMask, drawWord);
			const { finalCards } = await vp.getBetCards(betId);
			for (let i = 0; i < HAND_SIZE; i++) {
				expect(Number(finalCards[i])).to.equal(expectedFinal[i]);
			}
			const base = await vp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(Number(base.holdMask)).to.equal(holdMask);
		});
	});

	describe('Callback gating', () => {
		it('onVrfFulfilled rejects non-core sender', async () => {
			const { vp, player } = ctx;
			await expect(vp.connect(player).onVrfFulfilled(1n, [42n])).to.be.revertedWithCustomError(
				vp,
				'InvalidSender'
			);
		});

		it('onVrfFulfilled with unknown requestId is a silent no-op', async () => {
			const { vp, coreAddr } = ctx;
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(vp.connect(coreSigner).onVrfFulfilled(99999999n, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});
	});

	describe('Cancel paths', () => {
		it('user cancelBet rejected before timeout (AWAITING_DEAL)', async () => {
			const { vp, usdcAddr, player } = ctx;
			const tx = await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = parseBetPlaced(ctx, r);
			await expect(vp.connect(player).cancelBet(placed.args.betId)).to.be.revertedWithCustomError(
				vp,
				'CancelTimeoutNotReached'
			);
		});

		it('user cancelBet from AWAITING_DEAL after timeout refunds full stake', async () => {
			const { vp, vpAddr, core, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = parseBetPlaced(ctx, r);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await vp.connect(player).cancelBet(placed.args.betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await core.reservedProfitPerGame(vpAddr, usdcAddr)).to.equal(0n);
			const base = await vp.getBetBase(placed.args.betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('user cancelBet rejected from PLAYER_TURN (must call draw)', async () => {
			const { vp, player } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await expect(vp.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				vp,
				'InvalidBetStatus'
			);
		});

		it('user cancelBet from AWAITING_DRAW after timeout refunds full stake', async () => {
			const { vp, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await vp.connect(player).draw(betId, 0);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await vp.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			const base = await vp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('adminCancelBet works from AWAITING_DEAL (no timeout)', async () => {
			const { vp, usdcAddr, player, resolver } = ctx;
			const tx = await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = parseBetPlaced(ctx, r);
			await expect(vp.connect(resolver).adminCancelBet(placed.args.betId)).to.not.be.reverted;
			const base = await vp.getBetBase(placed.args.betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('adminCancelBet works from PLAYER_TURN', async () => {
			const { vp, resolver } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await vp.connect(resolver).adminCancelBet(betId);
			const base = await vp.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('adminCancelBet by non-resolver is rejected', async () => {
			const { vp, usdcAddr, player } = ctx;
			const tx = await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = parseBetPlaced(ctx, r);
			await expect(
				vp.connect(player).adminCancelBet(placed.args.betId)
			).to.be.revertedWithCustomError(vp, 'InvalidSender');
		});

		it('adminCancelBet on a resolved bet reverts InvalidBetStatus', async () => {
			const { vp, resolver } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await drawAndResolve(ctx, betId, 0, 0x2n);
			await expect(vp.connect(resolver).adminCancelBet(betId)).to.be.revertedWithCustomError(
				vp,
				'InvalidBetStatus'
			);
		});
	});

	describe('Free bet (via FBH forwarder)', () => {
		async function fundFB(amount) {
			const { fbh, fbhAddr, usdc, owner, player, usdcAddr } = ctx;
			await usdc.mintForUser(owner.address);
			await usdc.connect(owner).transfer(fbhAddr, amount);
			await fbh.setBalance(player.address, usdcAddr, amount);
		}

		async function placeFreeBet(amount) {
			const { fbh, vpAddr, usdcAddr, player, vp } = ctx;
			const data = vp.interface.encodeFunctionData('placeBetWithFreeBet', [
				usdcAddr,
				amount,
				ethers.ZeroAddress,
			]);
			const tx = await fbh.connect(player).forwardCall(vpAddr, data);
			const r = await tx.wait();
			const placed = parseBetPlaced(ctx, r);
			return { betId: placed.args.betId, requestId: placed.args.requestId };
		}

		it('placeBetWithFreeBet from non-FBH reverts InvalidSender', async () => {
			const { vp, usdcAddr, player } = ctx;
			await expect(
				vp.connect(player).placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(vp, 'InvalidSender');
		});

		it('placement debits FBH; user wallet untouched', async () => {
			const { fbh, usdc, usdcAddr, player } = ctx;
			await fundFB(MIN_USDC_BET);
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeFreeBet(MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
			const base = await ctx.vp.getBetBase(betId);
			expect(base.user).to.equal(player.address);
		});

		it('free-bet win routes payout through FBH', async () => {
			const { vrf, coreAddr, fbh } = ctx;
			await fundFB(MIN_USDC_BET);
			const dealWord = findWord('fb-win', (cards) => {
				const ev = evaluateFive(cards);
				return ev.class_ === HandClass.PAIR && ev.primaryRank >= 11;
			});
			const { betId, requestId } = await placeFreeBet(MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [dealWord]);
			await drawAndResolve(ctx, betId, 31, 0x1n);
			expect(await fbh.confirmCalls()).to.equal(1n);
			// Stake + 1× win = 2× stake routed to FBH for resolution
			expect(await fbh.lastExercised()).to.equal(MIN_USDC_BET * 2n);
			expect(await fbh.lastStake()).to.equal(MIN_USDC_BET);
		});

		it('free-bet loss: no payout, no FBH confirm call (loss is silent)', async () => {
			const { vrf, coreAddr, fbh } = ctx;
			await fundFB(MIN_USDC_BET);
			const dealWord = findWord('fb-loss', (cards) => {
				const ev = evaluateFive(cards);
				return ev.class_ === HandClass.HIGH_CARD;
			});
			const { betId, requestId } = await placeFreeBet(MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [dealWord]);
			await drawAndResolve(ctx, betId, 31, 0x1n);
			expect(await fbh.confirmCalls()).to.equal(0n);
		});

		it('free-bet cancel: stake refunded back to FBH balance', async () => {
			const { vp, fbh, usdcAddr, player } = ctx;
			await fundFB(MIN_USDC_BET);
			const { betId } = await placeFreeBet(MIN_USDC_BET);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await vp.connect(player).cancelBet(betId);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				MIN_USDC_BET
			);
		});
	});

	describe('Reservation lifecycle', () => {
		it('reservation released on resolve', async () => {
			const { vp, vpAddr, core, usdcAddr } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			expect(await core.reservedProfitPerGame(vpAddr, usdcAddr)).to.equal(801n * MIN_USDC_BET);
			await drawAndResolve(ctx, betId, 0, 0x2n);
			expect(await core.reservedProfitPerGame(vpAddr, usdcAddr)).to.equal(0n);
		});

		it('reservation released on admin cancel', async () => {
			const { vp, vpAddr, core, usdcAddr, resolver } = ctx;
			const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await vp.connect(resolver).adminCancelBet(betId);
			expect(await core.reservedProfitPerGame(vpAddr, usdcAddr)).to.equal(0n);
		});
	});

	describe('Referrer + admin', () => {
		it('sets referrer on placeBet when referrer != 0', async () => {
			const { vp, core, owner, usdcAddr, player } = ctx;
			const Mock = await ethers.getContractFactory('MockReferrals');
			const refContract = await Mock.deploy();
			const refAddr = await refContract.getAddress();
			await core
				.connect(owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					refAddr
				);
			const referrer = ethers.Wallet.createRandom().address;
			await vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, referrer);
			expect(await refContract.referrals(player.address)).to.equal(referrer);
		});

		it('setPausedByRole gated; pauser blocks new bets', async () => {
			const { vp, usdcAddr, pauser, player } = ctx;
			await vp.connect(pauser).setPausedByRole(true);
			await expect(
				vp.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});

		it('non-owner cannot setCore', async () => {
			const { vp, player } = ctx;
			await expect(
				vp.connect(player).setCore(ethers.Wallet.createRandom().address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});
	});

	/* ========== Admin zero-address + setManager / setPausedByRole ========== */

	describe('Admin: setCore / setManager zero-address + role gating', () => {
		it('setCore rejects zero address', async () => {
			const { vp, owner } = ctx;
			await expect(vp.connect(owner).setCore(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				vp,
				'InvalidAddress'
			);
		});

		it('setCore updates the core when called by owner', async () => {
			const { vp, owner } = ctx;
			const newCore = ethers.Wallet.createRandom().address;
			await vp.connect(owner).setCore(newCore);
			expect(await vp.core()).to.equal(newCore);
		});

		it('setManager rejects zero address', async () => {
			const { vp, owner } = ctx;
			await expect(vp.connect(owner).setManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				vp,
				'InvalidAddress'
			);
		});

		it('setManager updates the manager when called by owner', async () => {
			const { vp, owner } = ctx;
			const newMgr = ethers.Wallet.createRandom().address;
			await vp.connect(owner).setManager(newMgr);
			expect(await vp.manager()).to.equal(newMgr);
		});

		it('non-owner cannot setManager', async () => {
			const { vp, player } = ctx;
			await expect(
				vp.connect(player).setManager(ethers.Wallet.createRandom().address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('setPausedByRole no-op when called with current paused value', async () => {
			const { vp, pauser } = ctx;
			expect(await vp.paused()).to.equal(false);
			// Calling with the current (false) value should be a no-op — no event, no state change
			const tx = await vp.connect(pauser).setPausedByRole(false);
			const r = await tx.wait();
			const paused = r.logs.filter((l) => {
				try {
					const parsed = vp.interface.parseLog(l);
					return parsed?.name === 'PauseChanged';
				} catch {
					return false;
				}
			});
			expect(paused.length).to.equal(0);
			expect(await vp.paused()).to.equal(false);
		});

		it('setPausedByRole emits + sets lastPauseTime on first pause', async () => {
			const { vp, pauser } = ctx;
			await expect(vp.connect(pauser).setPausedByRole(true))
				.to.emit(vp, 'PauseChanged')
				.withArgs(true);
			expect(await vp.paused()).to.equal(true);
			// Toggle back to false: should also emit (no lastPauseTime branch but emits)
			await expect(vp.connect(pauser).setPausedByRole(false))
				.to.emit(vp, 'PauseChanged')
				.withArgs(false);
		});

		it('setPausedByRole rejects non-pauser non-owner caller', async () => {
			const { vp, player } = ctx;
			await expect(vp.connect(player).setPausedByRole(true)).to.be.revertedWithCustomError(
				vp,
				'InvalidSender'
			);
		});

		it('setPausedByRole accepts the owner directly', async () => {
			const { vp, owner } = ctx;
			await vp.connect(owner).setPausedByRole(true);
			expect(await vp.paused()).to.equal(true);
		});
	});

	/* ========== Views: pagination edge cases ========== */

	describe('View pagination', () => {
		it('getUserBetIds returns [] when user has no bets', async () => {
			const { vp } = ctx;
			const random = ethers.Wallet.createRandom().address;
			expect((await vp.getUserBetIds(random, 0, 10)).length).to.equal(0);
		});

		it('getUserBetIds returns [] when offset >= length', async () => {
			const { vp, player } = ctx;
			await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			expect((await vp.getUserBetIds(player.address, 5, 10)).length).to.equal(0);
		});

		it('getUserBetIds paginates and orders most-recent first', async () => {
			const { vp, player } = ctx;
			const ids = [];
			// Resolve each bet to free the 801× reservation before placing the next
			for (let i = 0; i < 3; i++) {
				const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, BigInt(0x100 + i));
				await drawAndResolve(ctx, betId, 31, BigInt(0x100 + i));
				ids.push(betId);
			}
			const first = await vp.getUserBetIds(player.address, 0, 2);
			expect(first.length).to.equal(2);
			expect(first[0]).to.equal(ids[2]);
			expect(first[1]).to.equal(ids[1]);
			const second = await vp.getUserBetIds(player.address, 2, 2);
			expect(second.length).to.equal(1);
			expect(second[0]).to.equal(ids[0]);
		});

		it('getRecentBetIds returns [] when no bets placed', async () => {
			const { vp } = ctx;
			expect((await vp.getRecentBetIds(0, 10)).length).to.equal(0);
		});

		it('getRecentBetIds returns [] when offset >= latest', async () => {
			const { vp } = ctx;
			await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			expect((await vp.getRecentBetIds(5, 10)).length).to.equal(0);
		});

		it('getRecentBetIds paginates with limit smaller than total', async () => {
			const { vp } = ctx;
			for (let i = 0; i < 3; i++) {
				const { betId } = await placeAndDeal(ctx, MIN_USDC_BET, BigInt(0x200 + i));
				await drawAndResolve(ctx, betId, 31, BigInt(0x200 + i));
			}
			const recent = await vp.getRecentBetIds(0, 2);
			expect(recent.length).to.equal(2);
			expect(recent[0]).to.equal(3n);
			expect(recent[1]).to.equal(2n);
		});
	});

	/* ========== Stale VRF callback ========== */

	describe('VRF stale callback for known bet in wrong state', () => {
		it('onVrfFulfilled is a silent no-op when bet is already RESOLVED', async () => {
			const { vp, coreAddr, vrf } = ctx;
			const { betId, requestId } = await placeAndDeal(ctx, MIN_USDC_BET, 0x1n);
			await drawAndResolve(ctx, betId, 0, 0x2n);
			// The original deal requestId mapping was cleared on draw; calling again on it should
			// hit the betId == 0 early-return path
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(vp.connect(coreSigner).onVrfFulfilled(requestId, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});
	});
});
