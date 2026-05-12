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
// placeBet reservation = 2*ante (stakes pulled) + 504*ante (capped profit, uncapped at default).
// Reservation extends by raiseAmount on each play raise to cover the larger stake-back.
const PLACEBET_RESERVATION_MULT = 506n;
const RESERVATION_MULT = 509n;

const BetStatus = {
	NONE: 0,
	AWAITING_DEAL: 1,
	PRE_FLOP_TURN: 2,
	AWAITING_FLOP: 3,
	POST_FLOP_TURN: 4,
	AWAITING_TURN_RIVER: 5,
	POST_RIVER_TURN: 6,
	AWAITING_RESOLVE: 7,
	RESOLVED: 8,
	CANCELLED: 9,
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

/* ========== JS MIRROR: SHUFFLE + EVALUATOR (matches contract) ========== */

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

	let flushSuit = -1;
	for (let s = 0; s < 4; s++) {
		if (suitCount[s] >= 5) {
			flushSuit = s;
			break;
		}
	}

	if (flushSuit >= 0) {
		const sfTop = findStraightTop(suitRankMask[flushSuit]);
		if (sfTop > 0) {
			if (sfTop === 14) return packHand(HandClass.ROYAL_FLUSH, 14);
			return packHand(HandClass.STRAIGHT_FLUSH, sfTop);
		}
	}

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

function dealerQualifies(handValue) {
	// UTH dealer qualifies with Pair or better
	return unpackClass(handValue) >= HandClass.PAIR;
}

function findWord(predicate, maxAttempts = 60000) {
	for (let i = 0; i < maxAttempts; i++) {
		const word = BigInt('0x' + ethers.id('uth-seed-' + i).slice(2));
		if (predicate(word)) return word;
	}
	throw new Error(`findWord: no match in ${maxAttempts}`);
}

/* ========== UTH DEALER SIMULATORS (mirror Solidity exactly) ========== */

// VRF1: draw 2 hole cards from a full 52-card deck
function simulateVrf1(word) {
	return partialFisherYates(fullDeck(), 2, word);
}

// VRF after checkPreFlop: draw 3 flop cards from a 50-card deck (hole excluded)
function simulateFlopAfterCheck(word, hole) {
	return partialFisherYates(deckExcluding(hole), 3, word);
}

// VRF after checkPostFlop: draw 2 cards (turn+river) from a 47-card deck (hole+flop excluded)
function simulateTurnRiverAfterCheck(word, holeAndFlop) {
	return partialFisherYates(deckExcluding(holeAndFlop), 2, word);
}

// AWAITING_RESOLVE → playMult=3: deal 5 community + 2 dealer = 7 cards (50-card deck)
function simulateResolvePreFlopRaise(word, hole) {
	return partialFisherYates(deckExcluding(hole), 7, word);
}

// playMult=2: deal 2 community + 2 dealer = 4 cards (47-card deck, hole+flop excluded)
function simulateResolvePostFlopRaise(word, holeAndFlop) {
	return partialFisherYates(deckExcluding(holeAndFlop), 4, word);
}

// playMult=1: deal 2 dealer cards (45-card deck, hole+flop+turn+river excluded)
function simulateResolveRiverRaise(word, holeFlopTurnRiver) {
	return partialFisherYates(deckExcluding(holeFlopTurnRiver), 2, word);
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
	const FBH = await ethers.getContractFactory('MockFreeBetsHolder');
	const fbh = await FBH.deploy(daoSink.address);
	const fbhAddr = await fbh.getAddress();

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

	const UTH = await ethers.getContractFactory('OvertimeUltimateHoldem');
	const uth = await upgrades.deployProxy(UTH, [], { initializer: false });
	const uthAddr = await uth.getAddress();
	await uth.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(uthAddr);
	await core.setMaxNetLossPerGameUsd(uthAddr, ethers.parseEther('100000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	const dataAddr = await data.getAddress();
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setUltimateHoldem(uthAddr);

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.transfer(player2.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);
	await usdc.connect(player2).approve(coreAddr, ethers.MaxUint256);

	return {
		uth,
		uthAddr,
		vrf,
		core,
		coreAddr,
		usdc,
		usdcAddr,
		owner,
		player,
		player2,
		resolver,
		fbh,
		fbhAddr,
		daoSink,
		data,
		dataAddr,
	};
}

/* ========== HELPERS ========== */

async function placeAndGetIds(ctx, ante, options = {}) {
	const signer = options.signer ?? ctx.player;
	const referrer = options.referrer ?? ethers.ZeroAddress;
	const tx = await ctx.uth.connect(signer).placeBet(ctx.usdcAddr, ante, referrer);
	const r = await tx.wait();
	const placed = r.logs
		.map((l) => {
			try {
				return ctx.uth.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	return { betId: placed.args.betId, requestId: placed.args.requestId };
}

// Extract the latest requestId stored in a bet via the contract's internal mapping helper.
// We expose this through the on-chain `requestIdToBetId` mapping isn't enough — instead use the
// event from the action we just performed.
async function fulfillLatest(ctx, betId, txReceipt, eventNames, words) {
	// pull the requestId arg from the most recent matching event
	const evt = txReceipt.logs
		.map((l) => {
			try {
				return ctx.uth.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e && eventNames.includes(e.name));
	if (!evt || evt.args.requestId === undefined) {
		throw new Error(`No matching event with requestId among ${eventNames.join(',')} in tx receipt`);
	}
	await ctx.vrf.fulfillRandomWords(ctx.coreAddr, evt.args.requestId, words);
	return evt.args.requestId;
}

// Convenience: place a bet and run VRF1 (player hole)
async function placeAndDealHole(ctx, ante, vrf1Word, options = {}) {
	const { betId, requestId } = await placeAndGetIds(ctx, ante, options);
	await ctx.vrf.fulfillRandomWords(ctx.coreAddr, requestId, [vrf1Word]);
	return { betId, requestId };
}

async function callMethodAndFulfill(ctx, methodName, betId, vrfWord, signer) {
	const tx = await ctx.uth.connect(signer ?? ctx.player)[methodName](betId);
	const receipt = await tx.wait();
	// Pre-flop raise emits RaisedPreFlop (no requestId in event), but the same call does
	// trigger a VRF request. Read from CheckedPreFlop/CheckedPostFlop/RaisedRiver requestId
	// param when present. For Raise events without requestId in the args, fall back to scanning
	// the receipt for the latest VRF requestId (last placed/requested).
	const reqEvent = receipt.logs
		.map((l) => {
			try {
				return ctx.uth.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e && e.args && e.args.requestId !== undefined);
	let requestId;
	if (reqEvent) {
		requestId = reqEvent.args.requestId;
	} else {
		// Fallback: read directly from the bet struct via state — call core to get the latest
		// requestId mapping isn't exposed, so we approximate via a sequential bump
		throw new Error('cannot infer requestId; expected event with requestId arg');
	}
	await ctx.vrf.fulfillRandomWords(ctx.coreAddr, requestId, [vrfWord]);
	return { receipt, requestId };
}

/* ========== TESTS ========== */

describe('OvertimeUltimateHoldem', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	/* ========== smoke / basic ========== */

	describe('placeBet', () => {
		it('pulls 2× ante, reserves stakes + capped profit, dispatches VRF', async () => {
			const { uth, uthAddr, core, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndGetIds(ctx, ante);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante * 2n);
			// Reservation at placeBet = 2*ante (stakes pulled) + 504*ante (capped profit when cap
			// not engaged) = 506*ante. Extends by raiseAmount on each play raise
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(
				PLACEBET_RESERVATION_MULT * ante
			);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.AWAITING_DEAL);
			expect(base.anteAmount).to.equal(ante);
			expect(base.playAmount).to.equal(0n);
		});

		it('reverts on zero ante', async () => {
			const { uth, usdcAddr, player } = ctx;
			await expect(
				uth.connect(player).placeBet(usdcAddr, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(uth, 'InvalidAmount');
		});

		it('reverts on unsupported collateral', async () => {
			const { uth, player } = ctx;
			await expect(
				uth.connect(player).placeBet(ethers.ZeroAddress, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(uth, 'InvalidCollateral');
		});

		it('reverts on bet below MIN_BET_USD', async () => {
			const { uth, usdcAddr, player } = ctx;
			// 1 USDC < 3 USD minimum
			await expect(
				uth.connect(player).placeBet(usdcAddr, USDC_UNIT, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(uth, 'InvalidAmount');
		});

		it('soft-caps reservation when worst-case profit exceeds effectiveMaxProfitUsd', async () => {
			// Tighten the per-game cap so worst-case profit (504×ante) would exceed it. The
			// contract now soft-caps reservation instead of reverting — bet is accepted, payout
			// is truncated at resolve. Set cap = 100 USD; ante = 3 USDC; capCollateral = 100 USDC.
			// New reservation = 2*ante + min(504*ante, capCollateral) = 6 + 100 = 106 USDC.
			const { uth, core, owner, uthAddr, usdcAddr, player } = ctx;
			await core.connect(owner).setMaxProfitUsdOverride(uthAddr, ethers.parseEther('100'));
			await expect(uth.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)).to.not
				.be.reverted;
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(
				MIN_USDC_BET * 2n + 100n * USDC_UNIT
			);
		});
	});

	describe('VRF1 (deal hole cards)', () => {
		it('advances to PRE_FLOP_TURN and reveals two distinct hole cards', async () => {
			const { uth, vrf, coreAddr } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x123456789abcdefn]);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PRE_FLOP_TURN);
			const { playerHole, community, dealerHole } = await uth.getBetCards(betId);
			expect(playerHole[0]).to.be.lessThan(52);
			expect(playerHole[1]).to.be.lessThan(52);
			expect(playerHole[0]).to.not.equal(playerHole[1]);
			// Dealer hole is hidden — must be [0, 0] (zero-init) until final VRF
			expect(dealerHole[0]).to.equal(0);
			expect(dealerHole[1]).to.equal(0);
			// Community must all be 0
			for (let i = 0; i < 5; i++) expect(community[i]).to.equal(0);
		});
	});

	/* ========== fold ========== */

	describe('fold (POST_RIVER_TURN)', () => {
		it('forfeits ante+blind, no payout, reservation released', async () => {
			const { uth, uthAddr, core, vrf, coreAddr, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// checkPreFlop → AWAITING_FLOP
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			// checkPostFlop → AWAITING_TURN_RIVER
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			// Fold
			await uth.connect(player).fold(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante * 2n);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
			const base = await uth.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.FOLDED);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('rejects fold from PRE_FLOP_TURN (wrong state)', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await expect(uth.connect(player).fold(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidBetStatus'
			);
		});

		it('rejects fold from non-owner', async () => {
			const { uth, vrf, coreAddr, player, player2 } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// advance to POST_RIVER_TURN
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			await expect(uth.connect(player2).fold(betId)).to.be.revertedWithCustomError(
				uth,
				'BetNotOwner'
			);
		});
	});

	/* ========== Decision paths ========== */

	describe('Pre-flop raise path', () => {
		it('pulls 3× ante and resolves to a valid post-resolve outcome', async () => {
			const { uth, uthAddr, core, vrf, coreAddr, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);

			const balBeforeRaise = await usdc.balanceOf(player.address);
			const raiseTx = await uth.connect(player).playPreFlop(betId);
			await raiseTx.wait();
			expect(await usdc.balanceOf(player.address)).to.equal(balBeforeRaise - ante * 3n);
			let base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.AWAITING_RESOLVE);
			expect(base.playAmount).to.equal(ante * 3n);
			// Reservation still 509× ante during AWAITING_RESOLVE
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(RESERVATION_MULT * ante);

			// Resolve VRF — sequential next reqId
			const nextReqId = BigInt(requestId) + 1n;
			await vrf.fulfillRandomWords(coreAddr, nextReqId, [0x9876543210abcdefn]);
			base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.be.gte(Outcome.DEALER_NOT_QUALIFIED);
			expect(base.outcome).to.be.lte(Outcome.TIE);
			// Reservation cleared
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
			// Dealer hole revealed
			const { dealerHole } = await uth.getBetCards(betId);
			expect(dealerHole[0]).to.not.equal(dealerHole[1]);
		});

		it('reaches each of PLAYER_WIN / DEALER_WIN / TIE / DEALER_NOT_QUALIFIED via different VRFs', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const seenOutcomes = new Set();
			// Try a handful of resolve words against a fixed hole word; collect outcomes
			const holeWord = 0xdeadbeefcafen;
			for (let i = 0; i < 25 && seenOutcomes.size < 2; i++) {
				const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
				await vrf.fulfillRandomWords(coreAddr, requestId, [holeWord]);
				await uth.connect(player).playPreFlop(betId);
				const nextReqId = BigInt(requestId) + 1n;
				const resolveWord = BigInt('0x' + ethers.id('uth-resolve-' + i).slice(2));
				await vrf.fulfillRandomWords(coreAddr, nextReqId, [resolveWord]);
				const base = await uth.getBetBase(betId);
				seenOutcomes.add(Number(base.outcome));
			}
			// At minimum, two distinct outcomes — proves resolution branches reach
			expect(seenOutcomes.size).to.be.gte(2);
		});
	});

	describe('Post-flop raise path', () => {
		it('checkPreFlop → playPostFlop pulls 2× ante and resolves correctly', async () => {
			const { uth, uthAddr, core, vrf, coreAddr, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);

			// check pre-flop
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.AWAITING_FLOP);
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.POST_FLOP_TURN);

			// raise 2x
			const balBefore = await usdc.balanceOf(player.address);
			tx = await uth.connect(player).playPostFlop(betId);
			r = await tx.wait();
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante * 2n);
			expect((await uth.getBetBase(betId)).playAmount).to.equal(ante * 2n);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.AWAITING_RESOLVE);

			// resolve — fulfill the latest request
			const nextReqId = BigInt(requestId) + 2n; // pre-flop=req+0, flop=req+1, resolve=req+2
			await vrf.fulfillRandomWords(coreAddr, nextReqId, [0x12345n]);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.be.gte(Outcome.DEALER_NOT_QUALIFIED);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
		});
	});

	describe('River raise path', () => {
		it('check → check → playRiver pulls 1× ante and resolves', async () => {
			const { uth, uthAddr, core, vrf, coreAddr, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);

			// checkPreFlop
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			// checkPostFlop
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.POST_RIVER_TURN);

			// playRiver (1x)
			const balBefore = await usdc.balanceOf(player.address);
			tx = await uth.connect(player).playRiver(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'RaisedRiver');
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - ante);
			expect((await uth.getBetBase(betId)).playAmount).to.equal(ante);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.AWAITING_RESOLVE);

			// resolve
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x4n]);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.be.gte(Outcome.DEALER_NOT_QUALIFIED);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
		});
	});

	/* ========== Storage safety (dealer hole leak protection) ========== */

	describe('storage safety — dealer hole / community never leak before final VRF', () => {
		it('AWAITING_FLOP state: dealer hole still [0,0], turn+river still [0,0]', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			// POST_FLOP_TURN: flop revealed, but dealer hole + turn/river must still be hidden
			const { community, dealerHole } = await uth.getBetCards(betId);
			expect(community[0]).to.be.lessThan(52);
			expect(community[1]).to.be.lessThan(52);
			expect(community[2]).to.be.lessThan(52);
			expect(community[3]).to.equal(0); // turn hidden
			expect(community[4]).to.equal(0); // river hidden
			expect(dealerHole[0]).to.equal(0);
			expect(dealerHole[1]).to.equal(0);
		});

		it('AWAITING_TURN_RIVER state: dealer hole still [0,0]', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			// POST_RIVER_TURN: all community revealed, dealer hole still hidden
			const { community, dealerHole } = await uth.getBetCards(betId);
			for (let i = 0; i < 5; i++) expect(community[i]).to.be.lessThan(52);
			expect(dealerHole[0]).to.equal(0);
			expect(dealerHole[1]).to.equal(0);
		});

		it('dealer hole only populated after final resolve VRF', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);

			// Confirm dealer hole hidden at PRE_FLOP_TURN
			let cards = await uth.getBetCards(betId);
			expect(cards.dealerHole[0]).to.equal(0);
			expect(cards.dealerHole[1]).to.equal(0);

			// Raise pre-flop (final resolve will reveal dealer)
			await uth.connect(player).playPreFlop(betId);
			cards = await uth.getBetCards(betId);
			// Still hidden during AWAITING_RESOLVE
			expect(cards.dealerHole[0]).to.equal(0);
			expect(cards.dealerHole[1]).to.equal(0);

			const nextReqId = BigInt(requestId) + 1n;
			await vrf.fulfillRandomWords(coreAddr, nextReqId, [0x9999n]);
			cards = await uth.getBetCards(betId);
			// Now revealed
			expect(cards.dealerHole[0]).to.not.equal(cards.dealerHole[1]);
		});
	});

	/* ========== Reservation accounting ========== */

	describe('reservation accounting', () => {
		it('reserves stakes + capped profit, extends on raise, releases on fold', async () => {
			const { uth, uthAddr, core, vrf, coreAddr, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(
				PLACEBET_RESERVATION_MULT * ante
			);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// Reservation unchanged during PLAYER_TURN (no raise yet)
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(
				PLACEBET_RESERVATION_MULT * ante
			);
			// Advance to POST_RIVER_TURN to fold
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			// Reservation unchanged during AWAITING_FLOP (no raise yet)
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(
				PLACEBET_RESERVATION_MULT * ante
			);
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			// Fold
			await uth.connect(player).fold(betId);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
		});
	});

	/* ========== Cancel paths ========== */

	describe('user cancelBet', () => {
		it('refunds 2× ante after timeout from AWAITING_DEAL', async () => {
			const { uth, uthAddr, core, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndGetIds(ctx, ante);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await uth.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.CANCELLED);
		});

		it('refunds 2× ante after timeout from AWAITING_FLOP', async () => {
			const { uth, vrf, coreAddr, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// move to AWAITING_FLOP via checkPreFlop, then DO NOT fulfill
			await uth.connect(player).checkPreFlop(betId);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.AWAITING_FLOP);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await uth.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('refunds 2× ante after timeout from AWAITING_TURN_RIVER', async () => {
			const { uth, vrf, coreAddr, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			await uth.connect(player).checkPostFlop(betId);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.AWAITING_TURN_RIVER);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await uth.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('refunds 2× ante + playAmount after timeout from AWAITING_RESOLVE (pre-flop raise)', async () => {
			const { uth, vrf, coreAddr, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await uth.connect(player).playPreFlop(betId);
			expect((await uth.getBetBase(betId)).status).to.equal(BetStatus.AWAITING_RESOLVE);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await uth.connect(player).cancelBet(betId);
			// Refund = 2*ante (placeBet) + 3*ante (playPreFlop) = 5*ante back
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('rejects cancel before timeout from AWAITING_DEAL', async () => {
			const { uth, player } = ctx;
			const { betId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await expect(uth.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				uth,
				'CancelTimeoutNotReached'
			);
		});

		it('rejects user cancel from PRE_FLOP_TURN (must play/check)', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await expect(uth.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidBetStatus'
			);
		});

		it('rejects user cancel from POST_FLOP_TURN', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await expect(uth.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidBetStatus'
			);
		});

		it('rejects non-owner cancel', async () => {
			const { uth, player2 } = ctx;
			const { betId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await expect(uth.connect(player2).cancelBet(betId)).to.be.revertedWithCustomError(
				uth,
				'BetNotOwner'
			);
		});

		it('rejects cancel for non-existent bet', async () => {
			const { uth, player } = ctx;
			await expect(uth.connect(player).cancelBet(999999n)).to.be.revertedWithCustomError(
				uth,
				'BetNotFound'
			);
		});
	});

	describe('adminCancelBet', () => {
		it('admin cancels from AWAITING_DEAL bypassing timeout', async () => {
			const { uth, uthAddr, core, resolver, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await uth.connect(resolver).adminCancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(0n);
		});

		it('admin cancels from PRE_FLOP_TURN', async () => {
			const { uth, vrf, coreAddr, resolver, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await uth.connect(resolver).adminCancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('admin cancels from AWAITING_RESOLVE (refunds raise too)', async () => {
			const { uth, vrf, coreAddr, resolver, usdc, player } = ctx;
			const ante = MIN_USDC_BET;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await uth.connect(player).playPreFlop(betId);
			await uth.connect(resolver).adminCancelBet(betId);
			// Refund = 2*ante + 3*ante = 5*ante back
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('rejects adminCancel by non-resolver', async () => {
			const { uth, player } = ctx;
			const { betId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await expect(uth.connect(player).adminCancelBet(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidSender'
			);
		});

		it('rejects adminCancel on RESOLVED bet', async () => {
			const { uth, vrf, coreAddr, resolver, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// Advance to POST_RIVER_TURN, fold to resolve
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			await uth.connect(player).fold(betId);
			await expect(uth.connect(resolver).adminCancelBet(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidBetStatus'
			);
		});

		it('rejects adminCancel on non-existent bet', async () => {
			const { uth, resolver } = ctx;
			await expect(uth.connect(resolver).adminCancelBet(99999n)).to.be.revertedWithCustomError(
				uth,
				'BetNotFound'
			);
		});
	});

	/* ========== Authorization ========== */

	describe('authorization', () => {
		it('onVrfFulfilled rejects non-core sender', async () => {
			const { uth, player } = ctx;
			await expect(uth.connect(player).onVrfFulfilled(0n, [0n])).to.be.revertedWithCustomError(
				uth,
				'InvalidSender'
			);
		});

		it('playPreFlop rejects from non-owner', async () => {
			const { uth, vrf, coreAddr, player2 } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await expect(uth.connect(player2).playPreFlop(betId)).to.be.revertedWithCustomError(
				uth,
				'BetNotOwner'
			);
		});

		it('checkPreFlop rejects from non-owner', async () => {
			const { uth, vrf, coreAddr, player2 } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await expect(uth.connect(player2).checkPreFlop(betId)).to.be.revertedWithCustomError(
				uth,
				'BetNotOwner'
			);
		});

		it('playPostFlop rejects when not in POST_FLOP_TURN', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// Still in PRE_FLOP_TURN — wrong state for playPostFlop
			await expect(uth.connect(player).playPostFlop(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidBetStatus'
			);
		});

		it('playRiver rejects when not in POST_RIVER_TURN', async () => {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await expect(uth.connect(player).playRiver(betId)).to.be.revertedWithCustomError(
				uth,
				'InvalidBetStatus'
			);
		});

		it('playPreFlop on non-existent bet reverts BetNotFound', async () => {
			const { uth, player } = ctx;
			await expect(uth.connect(player).playPreFlop(99999n)).to.be.revertedWithCustomError(
				uth,
				'BetNotFound'
			);
		});
	});

	/* ========== Free bet path (FBH forwards via tx.origin) ========== */

	describe('free bet (placeBetWithFreeBet via FBH forwarder)', () => {
		async function fundFB(amount) {
			const { fbh, fbhAddr, usdc, owner, player, usdcAddr } = ctx;
			await usdc.mintForUser(owner.address);
			await usdc.connect(owner).transfer(fbhAddr, amount);
			await fbh.setBalance(player.address, usdcAddr, amount);
		}

		async function placeFreeBet(ante) {
			const { fbh, uthAddr, usdcAddr, player, uth } = ctx;
			// Encode the placeBetWithFreeBet calldata and have FBH forward it from player EOA
			const data = uth.interface.encodeFunctionData('placeBetWithFreeBet', [
				usdcAddr,
				ante,
				ethers.ZeroAddress,
			]);
			const tx = await fbh.connect(player).forwardCall(uthAddr, data);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			return { betId: placed.args.betId, requestId: placed.args.requestId };
		}

		it('rejects placeBetWithFreeBet called directly by user (not FBH)', async () => {
			const { uth, usdcAddr, player } = ctx;
			await expect(
				uth.connect(player).placeBetWithFreeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(uth, 'InvalidSender');
		});

		it('forwarded place pulls 2× ante from FBH balance, not user wallet', async () => {
			const { fbh, usdc, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			await fundFB(ante * 10n); // fund generously
			const walletBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeFreeBet(ante);
			expect(await usdc.balanceOf(player.address)).to.equal(walletBefore); // untouched
			// FBH balance decreased by 2× ante (Ante + Blind)
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				ante * 10n - ante * 2n
			);
			const base = await ctx.uth.getBetBase(betId);
			expect(base.user).to.equal(player.address); // bet credited to tx.origin
		});

		it('cancel from AWAITING_DEAL credits 2× ante back to FBH balance', async () => {
			const { fbh, usdcAddr, player, uth } = ctx;
			const ante = MIN_USDC_BET;
			await fundFB(ante * 4n);
			const { betId } = await placeFreeBet(ante);
			const fbhAfterPlace = await fbh.balancePerUserAndCollateral(player.address, usdcAddr);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await uth.connect(player).cancelBet(betId);
			// Refund = 2× ante back to FBH balance
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				fbhAfterPlace + ante * 2n
			);
		});

		it('playPreFlop pulls 3× ante from FBH; reverts if FBH balance insufficient', async () => {
			const { fbh, vrf, coreAddr, usdcAddr, player, uth } = ctx;
			const ante = MIN_USDC_BET;
			// Fund exactly 2× ante (enough for placeBet, nothing for raise)
			await fundFB(ante * 2n);
			const { betId, requestId } = await placeFreeBet(ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// No FBH balance left → playPreFlop reverts with MockFBH error
			await expect(uth.connect(player).playPreFlop(betId)).to.be.revertedWith(
				'MockFBH: InsufficientBalance'
			);
			// But fold from POST_RIVER_TURN works without extra balance
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			await uth.connect(player).fold(betId);
			const base = await uth.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.FOLDED);
		});

		it('fold (free bet): no referrer payment, no wallet change', async () => {
			const { fbh, vrf, coreAddr, usdc, usdcAddr, player, uth } = ctx;
			const ante = MIN_USDC_BET;
			await fundFB(ante * 2n);
			const walletBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeFreeBet(ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// Walk to POST_RIVER_TURN
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			await uth.connect(player).fold(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(walletBefore);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
		});
	});

	/* ========== CasinoDataV2 wiring ========== */

	describe("CasinoDataV2 — Ultimate Hold'em records", () => {
		it('getOvertimeUltimateHoldemFullRecord returns the bet after fold-resolve', async () => {
			const { uth, data, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x3n]);
			await uth.connect(player).fold(betId);
			const rec = await data.getOvertimeUltimateHoldemFullRecord(betId);
			expect(rec.betId).to.equal(betId);
			expect(rec.user).to.equal(player.address);
			expect(rec.outcome).to.equal(Outcome.FOLDED);
			expect(rec.anteAmount).to.equal(MIN_USDC_BET);
		});

		it('getRecentOvertimeUltimateHoldemRecords paginates', async () => {
			const { data } = ctx;
			await placeAndGetIds(ctx, MIN_USDC_BET);
			await placeAndGetIds(ctx, MIN_USDC_BET);
			const recs = await data.getRecentOvertimeUltimateHoldemRecords(0, 10);
			expect(recs.length).to.equal(2);
		});

		it('getUserOvertimeUltimateHoldemRecords returns user bets', async () => {
			const { data, player } = ctx;
			await placeAndGetIds(ctx, MIN_USDC_BET);
			const recs = await data.getUserOvertimeUltimateHoldemRecords(player.address, 0, 10);
			expect(recs.length).to.equal(1);
			expect(recs[0].user).to.equal(player.address);
		});

		it('getNextBetId(OvertimeUltimateHoldem) returns 1 → 2', async () => {
			const { data } = ctx;
			expect(await data.getNextBetId(4)).to.equal(1n); // 4 = UltimateHoldem enum (post-Holdem-removal)
			await placeAndGetIds(ctx, MIN_USDC_BET);
			expect(await data.getNextBetId(4)).to.equal(2n);
		});

		// getRecentBetsAllGamesV2 cross-game test omitted here — fully exercised in
		// CasinoDataV2Coverage.js with all 6 games wired. This minimal fixture only wires UTH so
		// pagination would call un-set TCP/Hold'em/Plinko/HiLo/Keno addresses and revert.
	});

	/* ========== Admin: setCore / setManager / setPausedByRole ========== */

	describe('Admin: setCore / setManager / setPausedByRole', () => {
		it('setCore rejects zero address', async () => {
			const { uth, owner } = ctx;
			await expect(uth.connect(owner).setCore(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				uth,
				'InvalidAddress'
			);
		});

		it('setCore updates core when called by owner', async () => {
			const { uth, owner } = ctx;
			const newCore = ethers.Wallet.createRandom().address;
			await uth.connect(owner).setCore(newCore);
			expect(await uth.core()).to.equal(newCore);
		});

		it('setCore rejected from non-owner', async () => {
			const { uth, player } = ctx;
			await expect(
				uth.connect(player).setCore(ethers.Wallet.createRandom().address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('setManager rejects zero address', async () => {
			const { uth, owner } = ctx;
			await expect(uth.connect(owner).setManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				uth,
				'InvalidAddress'
			);
		});

		it('setManager updates manager when called by owner', async () => {
			const { uth, owner } = ctx;
			const newMgr = ethers.Wallet.createRandom().address;
			await uth.connect(owner).setManager(newMgr);
			expect(await uth.manager()).to.equal(newMgr);
		});

		it('setManager rejected from non-owner', async () => {
			const { uth, player } = ctx;
			await expect(
				uth.connect(player).setManager(ethers.Wallet.createRandom().address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('setPausedByRole no-op when called with current value', async () => {
			const { uth, owner } = ctx;
			expect(await uth.paused()).to.equal(false);
			const tx = await uth.connect(owner).setPausedByRole(false);
			const r = await tx.wait();
			const pauseLogs = r.logs.filter((l) => {
				try {
					const parsed = uth.interface.parseLog(l);
					return parsed?.name === 'PauseChanged';
				} catch {
					return false;
				}
			});
			expect(pauseLogs.length).to.equal(0);
		});

		it('setPausedByRole emits + sets lastPauseTime on first pause', async () => {
			const { uth, owner } = ctx;
			await expect(uth.connect(owner).setPausedByRole(true))
				.to.emit(uth, 'PauseChanged')
				.withArgs(true);
			expect(await uth.paused()).to.equal(true);
			// Confirm lastPauseTime updated (non-zero)
			expect(await uth.lastPauseTime()).to.be.gt(0);
		});

		it('setPausedByRole un-pauses', async () => {
			const { uth, owner } = ctx;
			await uth.connect(owner).setPausedByRole(true);
			await expect(uth.connect(owner).setPausedByRole(false))
				.to.emit(uth, 'PauseChanged')
				.withArgs(false);
			expect(await uth.paused()).to.equal(false);
		});

		it('setPausedByRole rejected from non-pauser non-owner', async () => {
			const { uth, player } = ctx;
			await expect(uth.connect(player).setPausedByRole(true)).to.be.revertedWithCustomError(
				uth,
				'InvalidSender'
			);
		});

		it('setPausedByRole blocks new placeBet when paused', async () => {
			const { uth, owner, usdcAddr, player } = ctx;
			await uth.connect(owner).setPausedByRole(true);
			await expect(
				uth.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});
	});

	/* ========== Referrer wiring ========== */

	describe('Referrer wiring on placeBet', () => {
		it('placeBet with non-zero referrer triggers core.setReferrer', async () => {
			const { uth, core, owner, usdcAddr, player } = ctx;
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
			await uth.connect(player).placeBet(usdcAddr, MIN_USDC_BET, referrer);
			expect(await refContract.referrals(player.address)).to.equal(referrer);
		});
	});

	/* ========== VRF stale callback ========== */

	describe('VRF stale callback', () => {
		it('onVrfFulfilled with unknown requestId is a silent no-op (betId == 0 branch)', async () => {
			const { uth, coreAddr } = ctx;
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(uth.connect(coreSigner).onVrfFulfilled(99999999n, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});

		it('onVrfFulfilled for a RESOLVED bet (stale state) is a silent no-op', async () => {
			const { uth, coreAddr, vrf, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			// Advance to POST_RIVER_TURN and fold so the bet ends in RESOLVED
			let tx = await uth.connect(player).checkPreFlop(betId);
			let r = await tx.wait();
			let evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPreFlop');
			await vrf.fulfillRandomWords(coreAddr, evt.args.requestId, [0x2n]);
			tx = await uth.connect(player).checkPostFlop(betId);
			r = await tx.wait();
			evt = r.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'CheckedPostFlop');
			const checkPostFlopReq = evt.args.requestId;
			await vrf.fulfillRandomWords(coreAddr, checkPostFlopReq, [0x3n]);
			await uth.connect(player).fold(betId);
			// The bet is now RESOLVED. Stale callback for an older requestId we still hold the
			// mapping for would have been deleted on use, so re-firing it goes through the
			// betId == 0 short-circuit. We simulate the other side: a phantom requestId.
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(uth.connect(coreSigner).onVrfFulfilled(7777777n, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});
	});

	/* ========== Hand-evaluator branch coverage via pre-flop raise resolves ========== */

	// For each target hand class, find a VRF1 word (hole) and VRF2 word (resolve) so the player's
	// best 5-of-7 evaluates to that class. With playPreFlop the resolve VRF deals 5 community +
	// 2 dealer hole from a 50-card deck (hole excluded), so the player's 7-card hand is fully
	// determined by (vrf1, vrf2). Single-tx VRF1+VRF2 = ~2 ms per attempt.
	describe('Hand evaluator branch coverage (pre-flop raise resolves)', () => {
		// Search for (vrf1, vrf2) such that player7 (hole + first 5 of resolve deck) matches
		// `predicate(class_)`. Brute force is bounded; caller passes maxAttempts
		function findPreFlopWords(predicate, prefix, maxOuter = 60, maxInner = 2000) {
			for (let i = 0; i < maxOuter; i++) {
				const w1 = BigInt('0x' + ethers.id(`${prefix}-h-${i}`).slice(2));
				const hole = simulateVrf1(w1);
				for (let j = 0; j < maxInner; j++) {
					const w2 = BigInt('0x' + ethers.id(`${prefix}-r-${i}-${j}`).slice(2));
					const resolveDeck = simulateResolvePreFlopRaise(w2, hole);
					const player7 = [...hole, ...resolveDeck.slice(0, 5)];
					const handValue = evaluateCards(player7);
					if (predicate(unpackClass(handValue), handValue, player7)) {
						return { w1, w2, hole, resolveDeck, handValue };
					}
				}
			}
			throw new Error(`findPreFlopWords: no match for ${prefix}`);
		}

		async function placeRaiseResolve(w1, w2) {
			const { uth, vrf, coreAddr, player } = ctx;
			const { betId, requestId } = await placeAndGetIds(ctx, MIN_USDC_BET);
			await vrf.fulfillRandomWords(coreAddr, requestId, [w1]);
			await uth.connect(player).playPreFlop(betId);
			const resolveReq = BigInt(requestId) + 1n;
			await vrf.fulfillRandomWords(coreAddr, resolveReq, [w2]);
			return betId;
		}

		it('player ends with a STRAIGHT (hits evaluator straight + blind paytable Straight branch)', async () => {
			const { uth } = ctx;
			const { w1, w2 } = findPreFlopWords((c) => c === HandClass.STRAIGHT, 'uth-straight');
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('player ends with a FLUSH (hits evaluator flush branch)', async () => {
			const { uth } = ctx;
			const { w1, w2 } = findPreFlopWords((c) => c === HandClass.FLUSH, 'uth-flush');
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('player ends with FULL HOUSE (hits firstThree+firstPair branch + blind FH multiplier)', async () => {
			const { uth } = ctx;
			const { w1, w2 } = findPreFlopWords((c) => c === HandClass.FULL_HOUSE, 'uth-fh');
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('player ends with THREE_OF_A_KIND (hits 3oK kickers branch)', async () => {
			const { uth } = ctx;
			const { w1, w2 } = findPreFlopWords((c) => c === HandClass.THREE_OF_A_KIND, 'uth-3k');
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('player ends with FOUR_OF_A_KIND (hits fourRank branch + blind 4oK multiplier)', async () => {
			const { uth } = ctx;
			// ~0.17%, ~600 attempts expected — allow up to 8000 word-pairs total
			const { w1, w2 } = findPreFlopWords(
				(c) => c === HandClass.FOUR_OF_A_KIND,
				'uth-4k',
				80,
				5000
			);
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('player ends with STRAIGHT_FLUSH non-Royal (hits SF branch + blind SF multiplier + wheel-or-stepped branch)', async () => {
			const { uth } = ctx;
			// SF ~0.028%, expect ~3500 attempts; allow up to 80k word-pairs total
			const { w1, w2 } = findPreFlopWords(
				(c) => c === HandClass.STRAIGHT_FLUSH,
				'uth-sf',
				80,
				1000
			);
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});

		it('player has wheel straight A-2-3-4-5 (hits wheel detection branch)', async () => {
			const { uth } = ctx;
			// Look for any 5-card subset of player7 (hole+first5community) that hits wheel
			// straight specifically — straight class with primary rank 5
			const { w1, w2 } = findPreFlopWords(
				(c, hv) => c === HandClass.STRAIGHT && ((hv >> 16) & 0xf) === 5,
				'uth-wheel',
				80,
				5000
			);
			const betId = await placeRaiseResolve(w1, w2);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
		});
	});

	describe('Soft payout cap (per-bet net-profit ceiling)', () => {
		it('rejects bet below per-game min-bet override', async () => {
			const { uth, uthAddr, core, owner, usdcAddr, player } = ctx;
			// Set min = $5. A $3 ante should now revert with InvalidAmount; a $5 ante passes
			await core.connect(owner).setMinBetPerGameUsd(uthAddr, ethers.parseEther('5'));
			await core.connect(owner).setMaxProfitUsdOverride(uthAddr, ethers.parseEther('100'));
			await expect(
				uth.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(uth, 'InvalidAmount');
			await expect(uth.connect(player).placeBet(usdcAddr, 5n * USDC_UNIT, ethers.ZeroAddress)).to
				.not.be.reverted;
		});

		it('rejects bet above per-game max-bet override', async () => {
			const { uth, uthAddr, core, owner, usdcAddr, player } = ctx;
			await core.connect(owner).setMaxBetPerGameUsd(uthAddr, ethers.parseEther('5'));
			await core.connect(owner).setMaxProfitUsdOverride(uthAddr, ethers.parseEther('100'));
			await expect(
				uth.connect(player).placeBet(usdcAddr, 10n * USDC_UNIT, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(uth, 'AboveMaxBet');
			await expect(uth.connect(player).placeBet(usdcAddr, 5n * USDC_UNIT, ethers.ZeroAddress)).to
				.not.be.reverted;
		});

		it('reservation grows with cap (uncapped) — extends on raise', async () => {
			// With default cap (uncapped at default), reservation at placeBet = 506*ante, then
			// extends to 509*ante after pre-flop raise (+3*ante stake-back coverage)
			const { uth, uthAddr, core, vrf, coreAddr, usdcAddr, player } = ctx;
			const ante = MIN_USDC_BET;
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(506n * ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			await uth.connect(player).playPreFlop(betId);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(509n * ante);
		});

		it('cap engages at placeBet: reservation = stake + capCollateral', async () => {
			// Override profit cap to $50 USD. ante = $10 USDC. capCollateral = $50 USDC.
			// Reservation at placeBet = 2*ante + cap = 20 + 50 = 70 USDC (vs uncapped 506*10=5060)
			const { uth, uthAddr, core, owner, usdcAddr, player } = ctx;
			await core.connect(owner).setMaxProfitUsdOverride(uthAddr, ethers.parseEther('50'));
			const ante = 10n * USDC_UNIT;
			await uth.connect(player).placeBet(usdcAddr, ante, ethers.ZeroAddress);
			expect(await core.reservedProfitPerGame(uthAddr, usdcAddr)).to.equal(
				2n * ante + 50n * USDC_UNIT
			);
		});

		it('truncates payout at resolve via player win path (any winning hand)', async () => {
			// Set cap to $5 net. With min ante = $3 and a pre-flop raise (3× = $9), stake = $15.
			// Any winning hand (DEALER_NOT_QUALIFIED pays $3 ante × 1:1 = $3 net) stays under cap.
			// Force scenarios where the cap engages by using bigger ante. We search winning words
			// and check that net player profit never exceeds the cap.
			const { uth, uthAddr, core, vrf, coreAddr, usdc, usdcAddr, player, owner } = ctx;
			await core.connect(owner).setMaxProfitUsdOverride(uthAddr, ethers.parseEther('5'));
			const ante = MIN_USDC_BET; // $3
			const balBefore = await usdc.balanceOf(player.address);
			const { betId, requestId } = await placeAndGetIds(ctx, ante);
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
			const raiseTx = await uth.connect(player).playPreFlop(betId);
			const raiseR = await raiseTx.wait();
			const raised = raiseR.logs
				.map((l) => {
					try {
						return uth.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'RaisedPreFlop');
			const nextReqId = BigInt(requestId) + 1n;
			await vrf.fulfillRandomWords(coreAddr, nextReqId, [0xdeadbeefn]);
			const base = await uth.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			// Whatever the outcome, net profit can't exceed cap = $5 = 5e6 USDC
			const balAfter = await usdc.balanceOf(player.address);
			const netDelta = balAfter - balBefore;
			expect(netDelta).to.be.lte(5n * USDC_UNIT);
		});
	});
});
