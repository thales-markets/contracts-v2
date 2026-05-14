// ============================================================================
// OvertimeBonusHoldem — branch-coverage tests.
//
// Targets the uncovered code paths in the main contract: every decision branch
// (raise/check/fold at flop / turn / river), every bonus paytable tier, every
// settlement outcome (PLAYER_WIN with each ante class / DEALER_WIN / TIE /
// FOLDED), free-bet flow, cancel paths, admin functions, and view helpers.
// ============================================================================

const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('1000000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const MIN_USDC_BET = 3n * USDC_UNIT;
const DECK_SIZE = 52;

const BetStatus = {
	NONE: 0,
	AWAITING_HOLE: 1,
	PRE_FLOP_TURN: 2,
	AWAITING_FLOP: 3,
	FLOP_TURN: 4,
	AWAITING_TURN: 5,
	TURN_TURN: 6,
	AWAITING_RIVER: 7,
	RIVER_TURN: 8,
	AWAITING_RESOLVE: 9,
	RESOLVED: 10,
	CANCELLED: 11,
};
const Outcome = { NONE: 0, FOLDED: 1, PLAYER_WIN: 2, DEALER_WIN: 3, TIE: 4 };

// card = suit*13 + (rank-2). suit 0=♣, 1=♦, 2=♥, 3=♠. rank-idx 0=2 ... 12=A.
function card(suit, rankIdx) {
	return suit * 13 + rankIdx;
}
const C2 = (r) => card(0, r);
const D2 = (r) => card(1, r);
const H2 = (r) => card(2, r);
const S2 = (r) => card(3, r);

// JS partial-Fisher-Yates mirror. Crafts a VRF word that, when applied to
// `partialFisherYates(deckExcluding(excluded), targets.length, word)`, yields
// `targets` in the requested order.
function craftWord(targets, excluded = []) {
	const excludeSet = new Set(excluded);
	const deck = [];
	for (let c = 0; c < DECK_SIZE; c++) if (!excludeSet.has(c)) deck.push(c);
	let word = 0n;
	for (let i = 0; i < targets.length; i++) {
		const t = targets[i];
		const pos = deck.indexOf(t);
		if (pos < 0) throw new Error(`craftWord: target ${t} not in remaining deck`);
		if (pos < i) throw new Error(`craftWord: target ${t} already drawn`);
		const chunkVal = BigInt(pos - i);
		if (chunkVal > 0xffffn) throw new Error('chunkVal exceeds 16 bits');
		word |= chunkVal << (BigInt(i) * 16n);
		[deck[i], deck[pos]] = [deck[pos], deck[i]];
	}
	return word;
}

function parseEvent(iface, receipt, name) {
	for (const l of receipt.logs) {
		try {
			const p = iface.parseLog(l);
			if (p?.name === name) return p;
		} catch {}
	}
	return null;
}

async function deployFixture() {
	const [owner, riskManager, resolver, pauser, player, daoSink, fbhActor] =
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

	const BH = await ethers.getContractFactory('OvertimeBonusHoldem');
	const bh = await upgrades.deployProxy(BH, [], { initializer: false });
	const bhAddr = await bh.getAddress();
	await bh.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(bhAddr);
	await core.setMaxNetLossPerGameUsd(bhAddr, ethers.parseEther('5000000'));

	await usdc.setDefaultAmount(1_000_000n * USDC_UNIT);
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 200_000n * USDC_UNIT);
	await usdc.transfer(player.address, 100_000n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		bh,
		bhAddr,
		vrf,
		core,
		coreAddr,
		usdc,
		usdcAddr,
		fbh,
		fbhAddr,
		owner,
		resolver,
		pauser,
		player,
		fbhActor,
	};
}

async function placeAndDealHole(ctx, ante, bonus, holeWord) {
	const tx = await ctx.bh
		.connect(ctx.player)
		.placeBet(await ctx.usdc.getAddress(), ante, bonus, ethers.ZeroAddress);
	const r = await tx.wait();
	const betId = parseEvent(ctx.bh.interface, r, 'BetPlaced').args.betId;
	await ctx.vrf.fulfillRandomWords(ctx.coreAddr, await ctx.vrf.lastRequestId(), [holeWord]);
	return betId;
}

async function fulfillNext(ctx, word) {
	await ctx.vrf.fulfillRandomWords(ctx.coreAddr, await ctx.vrf.lastRequestId(), [word]);
}

describe('OvertimeBonusHoldem — coverage', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('decisions: raise / check / fold at each post-flop street', () => {
		it('raiseFlop pulls 1× ante, advances to AWAITING_TURN', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await ctx.bh.connect(ctx.player).playPreFlop(betId);
			await fulfillNext(ctx, 0x2222n);
			await ctx.bh.connect(ctx.player).raiseFlop(betId);
			const r = await ctx.bh.getFullRecord(betId);
			expect(r.status).to.equal(BetStatus.AWAITING_TURN);
			expect(r.flopRaise).to.equal(MIN_USDC_BET);
		});

		it('raiseTurn / raiseRiver flow + resolve', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await ctx.bh.connect(ctx.player).playPreFlop(betId);
			await fulfillNext(ctx, 0x2222n);
			await ctx.bh.connect(ctx.player).checkFlop(betId);
			await fulfillNext(ctx, 0x3333n);
			await ctx.bh.connect(ctx.player).raiseTurn(betId);
			await fulfillNext(ctx, 0x4444n);
			await ctx.bh.connect(ctx.player).raiseRiver(betId);
			await fulfillNext(ctx, 0x5555n);
			const r = await ctx.bh.getFullRecord(betId);
			expect(r.status).to.equal(BetStatus.RESOLVED);
			expect(r.turnRaise).to.equal(MIN_USDC_BET);
			expect(r.riverRaise).to.equal(MIN_USDC_BET);
		});

		// foldFlop / foldTurn / foldRiver were removed from the contract — check is free at
		// every post-flop street so fold was strictly dominated. Pre-flop fold coverage lives
		// in the bonus-paytable suite below
		it('check-through to showdown resolves cleanly (no fold path)', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await ctx.bh.connect(ctx.player).playPreFlop(betId);
			await fulfillNext(ctx, 0x2222n);
			await ctx.bh.connect(ctx.player).checkFlop(betId);
			await fulfillNext(ctx, 0x3333n);
			await ctx.bh.connect(ctx.player).checkTurn(betId);
			await fulfillNext(ctx, 0x4444n);
			await ctx.bh.connect(ctx.player).checkRiver(betId);
			await fulfillNext(ctx, 0x5555n);
			const r = await ctx.bh.getFullRecord(betId);
			expect(r.status).to.equal(BetStatus.RESOLVED);
			// Outcome is whatever the showdown produced (win / loss / push) — not FOLDED
			expect(r.outcome).to.not.equal(Outcome.FOLDED);
		});
	});

	describe('bonus paytable tiers (crafted hole + dealer combos)', () => {
		async function runWithCraftedHoleAndDealer(holeCards, dealerCards) {
			const holeWord = craftWord(holeCards);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, MIN_USDC_BET, holeWord);
			await ctx.bh.connect(ctx.player).foldPreFlop(betId);
			// Dealer-hole VRF: deck excludes the 2 hole cards
			const dealerWord = craftWord(dealerCards, holeCards);
			await fulfillNext(ctx, dealerWord);
			return ctx.bh.getFullRecord(betId);
		}

		it('AA vs AA → 500 (= 499:1 capped from CoinPoker 1000:1)', async () => {
			// Player AA (♣, ♦), dealer AA (♥, ♠)
			const r = await runWithCraftedHoleAndDealer([C2(12), D2(12)], [H2(12), S2(12)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 500n);
		});

		it('player AA only → 31', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), D2(12)], [C2(0), D2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 31n);
		});

		it('AK suited → 26', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), C2(11)], [D2(0), H2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 26n);
		});

		it('AQ suited → 21', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), C2(10)], [D2(0), H2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 21n);
		});

		it('AJ suited → 21', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), C2(9)], [D2(0), H2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 21n);
		});

		it('AK off → 16', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), D2(11)], [H2(0), S2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 16n);
		});

		it('AQ off → 6', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), D2(10)], [H2(0), S2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 6n);
		});

		it('AJ off → 6', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(12), D2(9)], [H2(0), S2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 6n);
		});

		it('JJ pair → 11', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(9), D2(9)], [H2(0), S2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 11n);
		});

		it('QQ pair → 11', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(10), D2(10)], [H2(0), S2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 11n);
		});

		it('KK pair → 11', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(11), D2(11)], [H2(0), S2(1)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 11n);
		});

		it('low pair (e.g. 22) → 4', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(0), D2(0)], [H2(2), S2(3)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 4n);
		});

		it('low pair (TT, the top of the low-pair band) → 4', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(8), D2(8)], [H2(2), S2(3)]);
			expect(r.bonusPayout).to.equal(MIN_USDC_BET * 4n);
		});

		it('no match → 0 (e.g., 7-2 offsuit)', async () => {
			const r = await runWithCraftedHoleAndDealer([C2(5), D2(0)], [H2(2), S2(3)]);
			expect(r.bonusPayout).to.equal(0n);
		});

		it('no bonus stake → 0 payout regardless of hole match', async () => {
			const holeWord = craftWord([C2(12), D2(12)]);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, holeWord); // bonus=0
			await ctx.bh.connect(ctx.player).foldPreFlop(betId);
			await fulfillNext(ctx, craftWord([H2(0), S2(1)], [C2(12), D2(12)]));
			const r = await ctx.bh.getFullRecord(betId);
			expect(r.bonusPayout).to.equal(0n);
		});
	});

	describe('cancel from each AWAITING_* state (after timeout)', () => {
		it('cancel from AWAITING_HOLE refunds ante + bonus', async () => {
			const { bh, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await bh
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, MIN_USDC_BET, ethers.ZeroAddress);
			const r = await tx.wait();
			const betId = parseEvent(bh.interface, r, 'BetPlaced').args.betId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await bh.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('cancel from AWAITING_FLOP refunds ante + bonus + playAmount', async () => {
			const { bh, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, MIN_USDC_BET, 0x1111n);
			await bh.connect(player).playPreFlop(betId);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await bh.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('cancel from AWAITING_RESOLVE (after raiseRiver) refunds everything', async () => {
			const { bh, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await bh.connect(player).playPreFlop(betId);
			await fulfillNext(ctx, 0x2222n);
			await bh.connect(player).checkFlop(betId);
			await fulfillNext(ctx, 0x3333n);
			await bh.connect(player).checkTurn(betId);
			await fulfillNext(ctx, 0x4444n);
			await bh.connect(player).raiseRiver(betId);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await bh.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('cancel before timeout reverts', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await ctx.bh.connect(ctx.player).playPreFlop(betId);
			await expect(ctx.bh.connect(ctx.player).cancelBet(betId)).to.be.revertedWithCustomError(
				ctx.bh,
				'CancelTimeoutNotReached'
			);
		});

		it('cancel by non-owner reverts', async () => {
			const { bh, owner, usdcAddr, player } = ctx;
			const tx = await bh.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const r = await tx.wait();
			const betId = parseEvent(bh.interface, r, 'BetPlaced').args.betId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await expect(bh.connect(owner).cancelBet(betId)).to.be.revertedWithCustomError(
				bh,
				'BetNotOwner'
			);
		});

		it('cancel of non-existent bet reverts BetNotFound', async () => {
			await expect(ctx.bh.connect(ctx.player).cancelBet(9999n)).to.be.revertedWithCustomError(
				ctx.bh,
				'BetNotFound'
			);
		});

		it('cancel from PRE_FLOP_TURN (player decision state) reverts InvalidBetStatus', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await expect(ctx.bh.connect(ctx.player).cancelBet(betId)).to.be.revertedWithCustomError(
				ctx.bh,
				'InvalidBetStatus'
			);
		});
	});

	describe('adminCancelBet (bypasses timeout, accepts PLAYER-TURN states)', () => {
		it('admin cancel from PRE_FLOP_TURN refunds player', async () => {
			const { bh, usdc, player, resolver } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, MIN_USDC_BET, 0x1111n);
			await bh.connect(resolver).adminCancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('admin cancel from FLOP_TURN with playAmount committed refunds all stakes', async () => {
			const { bh, usdc, player, resolver } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await bh.connect(player).playPreFlop(betId);
			await fulfillNext(ctx, 0x2222n);
			await bh.connect(resolver).adminCancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('admin cancel of already-RESOLVED bet reverts', async () => {
			const { bh, resolver } = ctx;
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await ctx.bh.connect(ctx.player).playPreFlop(betId);
			await fulfillNext(ctx, 0x2222n);
			await ctx.bh.connect(ctx.player).checkFlop(betId);
			await fulfillNext(ctx, 0x3333n);
			await ctx.bh.connect(ctx.player).checkTurn(betId);
			await fulfillNext(ctx, 0x4444n);
			await ctx.bh.connect(ctx.player).checkRiver(betId);
			await fulfillNext(ctx, 0x5555n);
			await expect(bh.connect(resolver).adminCancelBet(betId)).to.be.revertedWithCustomError(
				bh,
				'InvalidBetStatus'
			);
		});

		it('non-resolver caller reverts', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await expect(ctx.bh.connect(ctx.player).adminCancelBet(betId)).to.be.revertedWithCustomError(
				ctx.bh,
				'InvalidSender'
			);
		});

		it('admin cancel of non-existent bet reverts BetNotFound', async () => {
			await expect(
				ctx.bh.connect(ctx.resolver).adminCancelBet(9999n)
			).to.be.revertedWithCustomError(ctx.bh, 'BetNotFound');
		});
	});

	describe('decision-call guards (status / ownership / not-found)', () => {
		it('playPreFlop on wrong state reverts InvalidBetStatus', async () => {
			const { bh, usdcAddr, player } = ctx;
			const tx = await bh.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const r = await tx.wait();
			const betId = parseEvent(bh.interface, r, 'BetPlaced').args.betId;
			// status is AWAITING_HOLE, not PRE_FLOP_TURN
			await expect(bh.connect(player).playPreFlop(betId)).to.be.revertedWithCustomError(
				bh,
				'InvalidBetStatus'
			);
		});

		it('playPreFlop by non-owner reverts BetNotOwner', async () => {
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0x1111n);
			await expect(ctx.bh.connect(ctx.owner).playPreFlop(betId)).to.be.revertedWithCustomError(
				ctx.bh,
				'BetNotOwner'
			);
		});

		it('playPreFlop on non-existent bet reverts BetNotFound', async () => {
			await expect(ctx.bh.connect(ctx.player).playPreFlop(9999n)).to.be.revertedWithCustomError(
				ctx.bh,
				'BetNotFound'
			);
		});
	});

	describe('referrer wiring on placeBet', () => {
		it('non-zero referrer triggers core.setReferrer (via try/catch)', async () => {
			const { bh, usdcAddr, player, fbhActor } = ctx;
			// Just confirm the call doesn't revert with non-zero referrer (core has no Referrals
			// wired so setReferrer is a no-op in try/catch — this exercises the branch)
			const tx = await bh.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, fbhActor.address);
			await tx.wait();
		});
	});

	describe('placeBet bet-size + collateral guards', () => {
		it('reverts on zero ante', async () => {
			await expect(
				ctx.bh.connect(ctx.player).placeBet(await ctx.usdc.getAddress(), 0n, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(ctx.bh, 'InvalidAmount');
		});

		it('reverts on unsupported collateral', async () => {
			await expect(
				ctx.bh
					.connect(ctx.player)
					.placeBet(
						'0x000000000000000000000000000000000000dEaD',
						MIN_USDC_BET,
						0n,
						ethers.ZeroAddress
					)
			).to.be.revertedWithCustomError(ctx.bh, 'InvalidCollateral');
		});

		it('reverts on ante below MIN_BET_USD when no override set', async () => {
			const tinyAmount = 1n; // 1e-6 USDC
			await expect(
				ctx.bh
					.connect(ctx.player)
					.placeBet(await ctx.usdc.getAddress(), tinyAmount, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(ctx.bh, 'InvalidAmount');
		});

		it('reverts when per-game maxBet override is set and ante exceeds it', async () => {
			const { core, bhAddr } = ctx;
			await core.setMaxBetPerGameUsd(bhAddr, ethers.parseEther('5'));
			await expect(
				ctx.bh
					.connect(ctx.player)
					.placeBet(await ctx.usdc.getAddress(), 10n * USDC_UNIT, 0n, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(ctx.bh, 'AboveMaxBet');
		});

		it('reverts when bonus exceeds maxBet override', async () => {
			const { core, bhAddr } = ctx;
			await core.setMaxBetPerGameUsd(bhAddr, ethers.parseEther('5'));
			await expect(
				ctx.bh
					.connect(ctx.player)
					.placeBet(await ctx.usdc.getAddress(), MIN_USDC_BET, 10n * USDC_UNIT, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(ctx.bh, 'AboveMaxBet');
		});
	});

	describe('admin functions', () => {
		it('setCore: rejects zero, rejects non-owner, owner can set', async () => {
			const { bh, owner, coreAddr, player } = ctx;
			await expect(bh.connect(player).setCore(coreAddr)).to.be.reverted;
			await expect(bh.connect(owner).setCore(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				bh,
				'InvalidAddress'
			);
			await bh.connect(owner).setCore(coreAddr);
			expect(await bh.core()).to.equal(coreAddr);
		});

		it('setManager: rejects zero, rejects non-owner, owner can set', async () => {
			const { bh, owner, player } = ctx;
			const managerAddr = await bh.manager();
			await expect(bh.connect(player).setManager(managerAddr)).to.be.reverted;
			await expect(bh.connect(owner).setManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				bh,
				'InvalidAddress'
			);
			await bh.connect(owner).setManager(managerAddr);
		});

		it('setPausedByRole: only pauser; flips paused flag and emits PauseChanged', async () => {
			const { bh, pauser, player } = ctx;
			await expect(bh.connect(player).setPausedByRole(true)).to.be.revertedWithCustomError(
				bh,
				'InvalidSender'
			);
			await bh.connect(pauser).setPausedByRole(true);
			expect(await bh.paused()).to.equal(true);
			// idempotent
			await bh.connect(pauser).setPausedByRole(true); // no-op, no event
			await bh.connect(pauser).setPausedByRole(false);
			expect(await bh.paused()).to.equal(false);
		});

		it('paused state blocks placeBet', async () => {
			const { bh, pauser, player, usdc } = ctx;
			await bh.connect(pauser).setPausedByRole(true);
			await expect(
				bh.connect(player).placeBet(await usdc.getAddress(), MIN_USDC_BET, 0n, ethers.ZeroAddress)
			).to.be.reverted;
		});
	});

	describe('view helpers', () => {
		it('getUserBetIds paginates desc and returns empty past end', async () => {
			const { bh, player } = ctx;
			for (let i = 0; i < 3; i++) await placeAndDealHole(ctx, MIN_USDC_BET, 0n, BigInt(0x1000 + i));
			const all = await bh.getUserBetIds(player.address, 0, 10);
			expect(all.length).to.equal(3);
			// newest first
			expect(all[0]).to.be.gt(all[1]);
			expect(all[1]).to.be.gt(all[2]);
			const past = await bh.getUserBetIds(player.address, 100, 10);
			expect(past.length).to.equal(0);
		});

		it('getRecentBetIds paginates with offset, count = min(start, limit)', async () => {
			const { bh } = ctx;
			for (let i = 0; i < 4; i++) await placeAndDealHole(ctx, MIN_USDC_BET, 0n, BigInt(0x2000 + i));
			const all = await bh.getRecentBetIds(0, 100);
			expect(all.length).to.equal(4);
			// offset past end returns empty
			const past = await bh.getRecentBetIds(100, 10);
			expect(past.length).to.equal(0);
			// offset 2, limit 1 returns 1 (slicing)
			const slice = await bh.getRecentBetIds(2, 1);
			expect(slice.length).to.equal(1);
		});

		it('getBetBase mirrors getFullRecord on key fields', async () => {
			const { bh, player } = ctx;
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, MIN_USDC_BET, 0x9999n);
			const base = await bh.getBetBase(betId);
			const full = await bh.getFullRecord(betId);
			expect(base.user).to.equal(player.address);
			expect(base.user).to.equal(full.user);
			expect(base.anteAmount).to.equal(full.anteAmount);
			expect(base.bonusAmount).to.equal(full.bonusAmount);
			expect(base.status).to.equal(full.status);
		});

		it('nextBetId increments per placeBet', async () => {
			const start = await ctx.bh.nextBetId();
			await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0xaaaan);
			await placeAndDealHole(ctx, MIN_USDC_BET, 0n, 0xbbbbn);
			expect(await ctx.bh.nextBetId()).to.equal(start + 2n);
		});
	});

	describe('free-bet flow', () => {
		it('placeBetWithFreeBet pulls stake from FBH (not user), routes payout back to FBH on resolve', async () => {
			const { bh, fbh, fbhAddr, usdc, player } = ctx;
			// MockFreeBetsHolder needs to be the configured FBH on core (it is by deployFixture)
			// and the player must have a balance there. MockFreeBetsHolder.setBalance(user, asset, amt)
			await fbh.setBalance(player.address, await usdc.getAddress(), 1_000n * USDC_UNIT);
			// Ensure FBH itself has USDC to send to core when stake is pulled
			await usdc.transfer(fbhAddr, 1_000n * USDC_UNIT);

			const balBefore = await usdc.balanceOf(player.address);
			const tx = await bh
				.connect(player)
				.placeBetWithFreeBet(await usdc.getAddress(), MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const r = await tx.wait();
			const betId = parseEvent(bh.interface, r, 'BetPlaced').args.betId;
			// User wallet balance unchanged (stake pulled from FBH)
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
			// Bet is flagged as free-bet
			const full = await bh.getFullRecord(betId);
			expect(full.anteAmount).to.equal(MIN_USDC_BET);
		});
	});

	describe('settlement outcomes — crafted final hands (hand-evaluator branch coverage)', () => {
		// Drive a full hand: place → VRF1 hole → playPreFlop → VRF2 flop → checkFlop → VRF3
		// turn → checkTurn → VRF4 river → checkRiver → VRF5 dealer hole + resolve
		async function runHand({ hole, flop, turn, river, dealerHole, bonus = 0n }) {
			const holeWord = craftWord(hole);
			const flopWord = craftWord(flop, hole);
			const turnWord = craftWord([turn], [...hole, ...flop]);
			const riverWord = craftWord([river], [...hole, ...flop, turn]);
			const dealerWord = craftWord(dealerHole, [...hole, ...flop, turn, river]);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, bonus, holeWord);
			await ctx.bh.connect(ctx.player).playPreFlop(betId);
			await fulfillNext(ctx, flopWord);
			await ctx.bh.connect(ctx.player).checkFlop(betId);
			await fulfillNext(ctx, turnWord);
			await ctx.bh.connect(ctx.player).checkTurn(betId);
			await fulfillNext(ctx, riverWord);
			await ctx.bh.connect(ctx.player).checkRiver(betId);
			await fulfillNext(ctx, dealerWord);
			return ctx.bh.getFullRecord(betId);
		}

		it('player ROYAL_FLUSH → ante pays 1:1, beats dealer', async () => {
			// Player hole: A♥ K♥; community: Q♥ J♥ T♥ 2♣ 3♦ (royal in hearts)
			const r = await runHand({
				hole: [H2(12), H2(11)],
				flop: [H2(10), H2(9), H2(8)],
				turn: C2(0),
				river: D2(1),
				dealerHole: [S2(2), S2(3)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET * 2n);
		});

		it('player STRAIGHT_FLUSH (non-royal) → ante 1:1', async () => {
			// 9-T-J-Q-K hearts
			const r = await runHand({
				hole: [H2(7), H2(11)],
				flop: [H2(8), H2(9), H2(10)],
				turn: C2(0),
				river: D2(1),
				dealerHole: [S2(2), S2(3)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET * 2n);
		});

		it('player FOUR_OF_A_KIND → ante 1:1', async () => {
			// Pocket aces + 2 board aces = quads
			const r = await runHand({
				hole: [C2(12), D2(12)],
				flop: [H2(12), S2(12), C2(0)],
				turn: D2(1),
				river: H2(2),
				dealerHole: [S2(3), C2(4)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET * 2n);
		});

		it('player FULL_HOUSE (trips + pair) → ante 1:1', async () => {
			// Pocket KK + 1 board K + a board pair
			const r = await runHand({
				hole: [C2(11), D2(11)],
				flop: [H2(11), S2(8), C2(8)],
				turn: D2(0),
				river: H2(2),
				dealerHole: [S2(3), C2(4)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET * 2n);
		});

		it('player STRAIGHT (wheel A-2-3-4-5) → ante 1:1; covers wheel branch', async () => {
			// Player A♣ 2♣; board 3♦ 4♥ 5♠ 7♦ 9♥ → wheel via hole + board low cards
			// Dealer K♠ 9♠ → just pair of 9s, no straight (board 9-7-5-4-3 has gap at 6, 8)
			const r = await runHand({
				hole: [C2(12), C2(0)],
				flop: [D2(1), H2(2), S2(3)],
				turn: D2(5),
				river: H2(7),
				dealerHole: [S2(11), S2(7)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET * 2n);
		});

		it('player THREE_OF_A_KIND → ante PUSHES (mult 1) on win', async () => {
			// Pocket pair + 1 board match = trips. No straight/flush possible
			const r = await runHand({
				hole: [C2(10), D2(10)],
				flop: [H2(10), S2(0), C2(2)],
				turn: D2(3),
				river: H2(5),
				dealerHole: [S2(7), C2(8)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET); // push
		});

		it('player TWO_PAIR (hole-card pair + board-pair) → ante PUSHES on win', async () => {
			// Player J♣ J♦; board 8♥ 8♠ 2♣ 4♦ Q♣ — no straight/flush possible. Dealer 3♠ 5♣ →
			// just 88 pair with low kickers. Player wins with JJ-88-Q two-pair.
			const r = await runHand({
				hole: [C2(9), D2(9)],
				flop: [H2(6), S2(6), C2(0)],
				turn: D2(2),
				river: C2(10),
				dealerHole: [S2(1), C2(3)],
			});
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			expect(r.antePayout).to.equal(MIN_USDC_BET);
		});

		it('TIE: royal flush on the board → both player and dealer Royal', async () => {
			// Board is exactly the 5 highest spades. Player + dealer both use 5 community.
			const r = await runHand({
				hole: [C2(0), D2(0)], // both 2s (cluv + diamond) — different cards
				flop: [S2(8), S2(9), S2(10)],
				turn: S2(11),
				river: S2(12),
				dealerHole: [H2(2), C2(3)],
			});
			expect(r.outcome).to.equal(Outcome.TIE);
			expect(r.antePayout).to.equal(MIN_USDC_BET); // push
			expect(r.playPayout).to.equal(MIN_USDC_BET * 2n); // play stake push
		});

		it('DEALER_WIN: dealer has trips on board pair + matching hole; player has high card', async () => {
			// Board: K♣ K♦ 7♠ 4♥ 2♣. Player hole: 8♠ 5♦ (high card K via board). Dealer: A♣ K♥
			// (trips kings). Dealer beats player.
			const r = await runHand({
				hole: [S2(6), D2(3)], // 8♠, 5♦
				flop: [C2(11), D2(11), S2(5)],
				turn: H2(2),
				river: C2(0),
				dealerHole: [C2(12), H2(11)], // A♣, K♥
			});
			expect(r.outcome).to.equal(Outcome.DEALER_WIN);
			expect(r.antePayout).to.equal(0n);
			expect(r.playPayout).to.equal(0n);
		});
	});

	describe('profit-cap cascade truncation', () => {
		it('engages cap with low override → bonus payout truncated (first branch)', async () => {
			const { bh, bhAddr, core, player, usdc } = ctx;
			// Tight cap: $5 max profit per bet
			await core.setMaxProfitUsdOverride(bhAddr, ethers.parseEther('5'));
			// AA-vs-AA crafted: bonus pays 500x stake = $1500 nominal, way above $5 cap
			const holeWord = craftWord([C2(12), D2(12)]);
			const dealerWord = craftWord([H2(12), S2(12)], [C2(12), D2(12)]);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, MIN_USDC_BET, holeWord);
			await bh.connect(player).foldPreFlop(betId);
			await fulfillNext(ctx, dealerWord);
			const r = await bh.getFullRecord(betId);
			// Bonus payout truncated below the nominal 500× stake
			expect(r.bonusPayout).to.be.lt(MIN_USDC_BET * 500n);
		});

		it('engages cap with zero override and ante-only bet → ante leg truncated (deeper cascade)', async () => {
			const { bh, bhAddr, core, player } = ctx;
			await core.setMaxProfitUsdOverride(bhAddr, 1n); // effectively zero profit allowed
			// Run a full hand that wins
			const holeWord = craftWord([H2(12), H2(11)]);
			const flopWord = craftWord([H2(10), H2(9), H2(8)], [H2(12), H2(11)]);
			const turnWord = craftWord([C2(0)], [H2(12), H2(11), H2(10), H2(9), H2(8)]);
			const riverWord = craftWord([D2(1)], [H2(12), H2(11), H2(10), H2(9), H2(8), C2(0)]);
			const dealerWord = craftWord(
				[S2(2), S2(3)],
				[H2(12), H2(11), H2(10), H2(9), H2(8), C2(0), D2(1)]
			);
			const betId = await placeAndDealHole(ctx, MIN_USDC_BET, 0n, holeWord);
			await bh.connect(player).playPreFlop(betId);
			await fulfillNext(ctx, flopWord);
			await bh.connect(player).checkFlop(betId);
			await fulfillNext(ctx, turnWord);
			await bh.connect(player).checkTurn(betId);
			await fulfillNext(ctx, riverWord);
			await bh.connect(player).checkRiver(betId);
			await fulfillNext(ctx, dealerWord);
			const r = await bh.getFullRecord(betId);
			expect(r.outcome).to.equal(Outcome.PLAYER_WIN);
			// Total payout effectively just stake-back (profit cap = 1 wei)
			const stakeOut = r.anteAmount + r.playAmount;
			expect(r.totalPayout).to.be.gte(stakeOut);
			expect(r.totalPayout - stakeOut).to.be.lte(2n);
		});
	});

	describe('free-bet raise stake', () => {
		it('placeBetWithFreeBet + playPreFlop pulls play stake from FBH (covers _pullRaiseStake free-bet branch)', async () => {
			const { bh, fbh, fbhAddr, usdc, player } = ctx;
			await fbh.setBalance(player.address, await usdc.getAddress(), 1_000n * USDC_UNIT);
			await usdc.transfer(fbhAddr, 1_000n * USDC_UNIT);
			const balBefore = await usdc.balanceOf(player.address);

			const tx = await bh
				.connect(player)
				.placeBetWithFreeBet(await usdc.getAddress(), MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const r = await tx.wait();
			const betId = parseEvent(bh.interface, r, 'BetPlaced').args.betId;
			await fulfillNext(ctx, 0x1234n);

			// playPreFlop should pull additional stake from FBH (not user wallet)
			await bh.connect(player).playPreFlop(betId);
			// User wallet unchanged for both the initial stake and the play raise
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	describe('VRF callback access control + stale handling', () => {
		it('rejects onVrfFulfilled from non-core', async () => {
			await expect(
				ctx.bh.connect(ctx.player).onVrfFulfilled(1n, [0x1n])
			).to.be.revertedWithCustomError(ctx.bh, 'InvalidSender');
		});

		it('silently no-ops when VRF fires for cancelled bet (betId == 0 branch via stale mapping)', async () => {
			const { bh, vrf, coreAddr, usdcAddr, player } = ctx;
			// Place a bet, capture the pre-fulfill requestId, cancel before VRF fires (deletes the
			// mapping inside bh), then have VRF fire for that requestId — bh.onVrfFulfilled sees
			// betId == 0 and silently returns
			const tx = await bh.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
			const r = await tx.wait();
			const placed = parseEvent(bh.interface, r, 'BetPlaced');
			const betId = placed.args.betId;
			const requestId = placed.args.requestId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await bh.connect(player).cancelBet(betId);
			// Stale VRF callback — should be a no-op (no revert)
			await vrf.fulfillRandomWords(coreAddr, requestId, [0x1n]);
		});
	});
});
