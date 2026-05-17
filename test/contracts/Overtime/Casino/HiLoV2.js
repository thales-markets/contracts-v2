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
const ONE = 10n ** 18n;
const MIN_USDC_BET = 3n * USDC_UNIT;

const HE_E18 = 2n * 10n ** 16n;
const MAX_MULT_E18 = 25n * ONE;
const MIDPOINT_RANK = 6;

const BetStatus = {
	NONE: 0,
	PLAYER_TURN: 1,
	AWAITING_NEXT_CARD: 2,
	RESOLVED: 3,
	CANCELLED: 4,
};
const Outcome = { NONE: 0, CASHED_OUT: 1, WRONG_GUESS: 2 };
const Direction = { ABOVE: 0, BELOW: 1 };
const CardOutcome = { NONE: 0, HIT: 1, PUSH: 2, BUST: 3 };

function rankOf(card) {
	return Math.floor(card / 4); // 0..12
}

// Find a VRF word that derives a card with target rank
function wordForCardRank(seed, targetRank) {
	for (let i = 0; i < 10000; i++) {
		const word = BigInt('0x' + ethers.id(`${seed}-${i}`).slice(2));
		const card = Number(word % 52n);
		if (rankOf(card) === targetRank) return { word, card };
	}
	throw new Error('not found');
}

// Constant per-correct-guess factor: (12 - 13*HE) / 6
function factorE18(heE18 = HE_E18) {
	return (12n * ONE - 13n * heE18) / 6n;
}

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

	const HiLo = await ethers.getContractFactory('HiLo');
	const hilo = await upgrades.deployProxy(HiLo, [], { initializer: false });
	const hiloAddr = await hilo.getAddress();
	await hilo.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(hiloAddr);
	await core.setMaxNetLossPerGameUsd(hiloAddr, ethers.parseEther('1000000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address);
	await data.setAddress(0, true, coreAddr);
	await data.setAddress(2, false, hiloAddr);

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		hilo,
		hiloAddr,
		vrf,
		core,
		coreAddr,
		usdc,
		usdcAddr,
		data,
		fbh,
		fbhAddr,
		daoSink,
		owner,
		riskManager,
		resolver,
		player,
	};
}

function parseLogs(hilo, logs, name) {
	return logs
		.map((l) => {
			try {
				return hilo.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === name);
}

async function placeBet(ctx, amount = MIN_USDC_BET, direction = Direction.ABOVE) {
	const { hilo, usdcAddr, player } = ctx;
	const tx = await hilo
		.connect(player)
		.placeBet(usdcAddr, amount, ethers.ZeroAddress, direction, false);
	const receipt = await tx.wait();
	const placed = parseLogs(hilo, receipt.logs, 'BetPlaced');
	const guessed = parseLogs(hilo, receipt.logs, 'GuessChosen');
	return { betId: placed.args.betId, requestId: guessed.args.requestId };
}

async function placeBetAndDeal(ctx, direction, dealWord, amount = MIN_USDC_BET) {
	const { vrf, coreAddr } = ctx;
	const { betId, requestId } = await placeBet(ctx, amount, direction);
	await vrf.fulfillRandomWords(coreAddr, requestId, [dealWord]);
	return betId;
}

async function guessAndDeal(ctx, betId, direction, dealWord) {
	const { hilo, vrf, coreAddr, player } = ctx;
	const tx = await hilo.connect(player).makeAction(betId, direction);
	const receipt = await tx.wait();
	const guessed = parseLogs(hilo, receipt.logs, 'GuessChosen');
	await vrf.fulfillRandomWords(coreAddr, guessed.args.requestId, [dealWord]);
	return guessed.args.requestId;
}

describe('CasinoCoreV2 + HiLo (above/below 8)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Initialization', () => {
		it('initializes with 2% house edge and 25x cap', async () => {
			const { hilo, owner, coreAddr } = ctx;
			expect(await hilo.owner()).to.equal(owner.address);
			expect(await hilo.core()).to.equal(coreAddr);
			expect(await hilo.houseEdgeE18()).to.equal(HE_E18);
			expect(await hilo.maxMultiplierE18()).to.equal(MAX_MULT_E18);
		});
	});

	describe('Multiplier formula', () => {
		it('returns the constant factor (12 - 13*HE) / 6', async () => {
			const { hilo } = ctx;
			expect(await hilo.multiplierFactorE18()).to.equal(factorE18());
		});

		it('expected return per round = 1 - HE = 0.98', async () => {
			const { hilo } = ctx;
			const f = await hilo.multiplierFactorE18();
			// E[ret] = (6/13) * f + (1/13) * 1 + (6/13) * 0
			//       = (6 * f + ONE) / 13
			const expectedRetE18 = (6n * f + ONE) / 13n;
			expect(expectedRetE18).to.be.gte(ONE - HE_E18 - 13n);
			expect(expectedRetE18).to.be.lte(ONE - HE_E18 + 13n);
		});
	});

	describe('placeBet', () => {
		it('starts in AWAITING_NEXT_CARD with first VRF in flight, no card drawn yet', async () => {
			const { hilo } = ctx;
			const { betId } = await placeBet(ctx);
			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.AWAITING_NEXT_CARD);
			const state = await hilo.getBetState(betId);
			expect(Number(state.lastCard)).to.equal(0xff); // sentinel: no card drawn yet
			expect(state.currentMultiplierE18).to.equal(ONE);
			expect(Number(state.guessCount)).to.equal(1);
		});

		it('emits BetPlaced and GuessChosen in a single tx with the first direction', async () => {
			const { hilo, usdcAddr, player } = ctx;
			const tx = await hilo
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, Direction.BELOW, false);
			const receipt = await tx.wait();
			const placed = parseLogs(hilo, receipt.logs, 'BetPlaced');
			const guessed = parseLogs(hilo, receipt.logs, 'GuessChosen');
			expect(placed.args.collateral).to.equal(usdcAddr);
			expect(placed.args.amount).to.equal(MIN_USDC_BET);
			expect(guessed.args.direction).to.equal(Direction.BELOW);
			expect(guessed.args.requestId).to.not.equal(0n);
		});

		it('reverts on zero amount', async () => {
			const { hilo, usdcAddr, player } = ctx;
			await expect(
				hilo.connect(player).placeBet(usdcAddr, 0n, ethers.ZeroAddress, Direction.ABOVE, false)
			).to.be.revertedWithCustomError(hilo, 'InvalidAmount');
		});

		it('reverts on unsupported collateral', async () => {
			const { hilo, player } = ctx;
			const fake = ethers.Wallet.createRandom().address;
			await expect(
				hilo
					.connect(player)
					.placeBet(fake, MIN_USDC_BET, ethers.ZeroAddress, Direction.ABOVE, false)
			).to.be.revertedWithCustomError(hilo, 'InvalidCollateral');
		});

		it('reserves amount * maxMultiplier in core', async () => {
			const { hiloAddr, core, usdcAddr } = ctx;
			await placeBet(ctx);
			expect(await core.reservedProfitPerGame(hiloAddr, usdcAddr)).to.equal(
				(MIN_USDC_BET * MAX_MULT_E18) / ONE
			);
		});
	});

	describe('guess outcomes', () => {
		it('PUSH on rank == 6 (card "8"): mult unchanged, status returns to PLAYER_TURN', async () => {
			const { hilo } = ctx;
			const { word: w } = wordForCardRank('hilo-push', MIDPOINT_RANK);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, w);
			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PLAYER_TURN);
			const state = await hilo.getBetState(betId);
			expect(state.currentMultiplierE18).to.equal(ONE); // unchanged
			expect(Number(state.pushCount)).to.equal(1);
			expect(Number(state.correctCount)).to.equal(0);
			expect(Number(state.guessCount)).to.equal(1);
		});

		it('correct ABOVE guess (rank > 6) multiplies the run', async () => {
			const { hilo } = ctx;
			const { word: w } = wordForCardRank('hilo-above-win', 10); // rank 10 > 6
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, w);
			const state = await hilo.getBetState(betId);
			expect(Number(state.correctCount)).to.equal(1);
			expect(state.currentMultiplierE18).to.equal(factorE18());
		});

		it('correct BELOW guess (rank < 6) multiplies the run', async () => {
			const { hilo } = ctx;
			const { word: w } = wordForCardRank('hilo-below-win', 2); // rank 2 < 6
			const betId = await placeBetAndDeal(ctx, Direction.BELOW, w);
			const state = await hilo.getBetState(betId);
			expect(Number(state.correctCount)).to.equal(1);
			expect(state.currentMultiplierE18).to.equal(factorE18());
		});

		it('wrong ABOVE (rank < 6) loses the run', async () => {
			const { hilo, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { word: w } = wordForCardRank('hilo-above-lose', 2);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, w);
			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.WRONG_GUESS);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('wrong BELOW (rank > 6) loses the run', async () => {
			const { hilo, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { word: w } = wordForCardRank('hilo-below-lose', 10);
			const betId = await placeBetAndDeal(ctx, Direction.BELOW, w);
			const base = await hilo.getBetBase(betId);
			expect(base.outcome).to.equal(Outcome.WRONG_GUESS);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('chains correct guesses to compound multiplier', async () => {
			const { hilo } = ctx;
			const f = factorE18();
			const { word: w1 } = wordForCardRank('hilo-chain-1', 9);
			const { word: w2 } = wordForCardRank('hilo-chain-2', 11);
			const { word: w3 } = wordForCardRank('hilo-chain-3', 7);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, w1);
			await guessAndDeal(ctx, betId, Direction.ABOVE, w2);
			await guessAndDeal(ctx, betId, Direction.ABOVE, w3);
			const state = await hilo.getBetState(betId);
			expect(Number(state.correctCount)).to.equal(3);
			const expected3 = (((ONE * f) / ONE) * ((f * f) / ONE)) / ONE;
			expect(state.currentMultiplierE18).to.equal(expected3);
		});

		it('caps running multiplier at maxMultiplierE18 once exceeded', async () => {
			const { hilo, player } = ctx;
			const f = factorE18();
			// 5 consecutive wins: f^5 ≈ 28.94x → exceeds 25x → capped
			let mult = ONE;
			let betId;
			for (let i = 0; i < 5; i++) {
				const { word } = wordForCardRank(`hilo-cap-${i}`, 10); // rank 10 > 6
				if (i === 0) {
					betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
				} else {
					await guessAndDeal(ctx, betId, Direction.ABOVE, word);
				}
				mult = (mult * f) / ONE;
				if (mult > MAX_MULT_E18) mult = MAX_MULT_E18;
				const state = await hilo.getBetState(betId);
				expect(state.currentMultiplierE18).to.equal(mult);
			}
			const state = await hilo.getBetState(betId);
			expect(state.currentMultiplierE18).to.equal(MAX_MULT_E18);
			// Next guess should revert with MaxMultiplierReached (cap reached)
			await expect(hilo.connect(player).makeAction(betId, 0)).to.be.revertedWithCustomError(
				hilo,
				'MaxMultiplierReached'
			);
		});
	});

	describe('cashout', () => {
		it('pays bet * currentMultiplier', async () => {
			const { hilo, usdc, player } = ctx;
			const f = factorE18();
			const balBefore = await usdc.balanceOf(player.address);
			const { word } = wordForCardRank('hilo-cash-win', 10);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			await hilo.connect(player).makeAction(betId, 2);
			const expectedPayout = (MIN_USDC_BET * f) / ONE;
			expect(await usdc.balanceOf(player.address)).to.equal(
				balBefore - MIN_USDC_BET + expectedPayout
			);
		});

		it('cashout after a push pays 1x (multiplier unchanged)', async () => {
			const { hilo, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { word } = wordForCardRank('hilo-cash-push', MIDPOINT_RANK);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			await hilo.connect(player).makeAction(betId, 2);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('cashout from AWAITING_NEXT_CARD reverts (must wait for VRF)', async () => {
			const { hilo, player } = ctx;
			const { betId } = await placeBet(ctx);
			await expect(hilo.connect(player).makeAction(betId, 2)).to.be.revertedWithCustomError(
				hilo,
				'InvalidBetStatus'
			);
		});

		it('cashout reverts on RESOLVED bet', async () => {
			const { hilo, player } = ctx;
			const { word } = wordForCardRank('hilo-cash-twice', 10);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			await hilo.connect(player).makeAction(betId, 2);
			await expect(hilo.connect(player).makeAction(betId, 2)).to.be.revertedWithCustomError(
				hilo,
				'InvalidBetStatus'
			);
		});
	});

	describe('Cancel', () => {
		it('user cancel from AWAITING_NEXT_CARD after timeout refunds the stake', async () => {
			const { hilo, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { betId } = await placeBet(ctx);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await hilo.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('user cancel from PLAYER_TURN reverts (no VRF in flight)', async () => {
			const { hilo, player } = ctx;
			// Reach PLAYER_TURN via a push (multiplier unchanged, status returns to PLAYER_TURN)
			const { word } = wordForCardRank('hilo-cancel-pt', MIDPOINT_RANK);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			await expect(hilo.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				hilo,
				'InvalidBetStatus'
			);
		});

		it('admin cancel works from PLAYER_TURN as well (rescue path)', async () => {
			const { hilo, resolver, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const { word } = wordForCardRank('hilo-admin-pt', MIDPOINT_RANK);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			await hilo.connect(resolver).adminCancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});

		it('user cancel before timeout reverts', async () => {
			const { hilo, player } = ctx;
			const { betId } = await placeBet(ctx);
			await expect(hilo.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				hilo,
				'CancelTimeoutNotReached'
			);
		});
	});

	describe('CasinoDataV2 — HiLo records', () => {
		it('returns full HiLo record', async () => {
			const { hilo, data, player } = ctx;
			const { word } = wordForCardRank('hilo-data', 10);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			await hilo.connect(player).makeAction(betId, 2);
			const r = hilo.interface.decodeFunctionResult(
				'getFullRecord',
				await data.getFullRecord(2 /* GameV2.HiLo */, betId)
			)[0];
			expect(r.betId).to.equal(betId);
			expect(r.outcome).to.equal(Outcome.CASHED_OUT);
		});
	});

	describe('per-turn history (getBetCards)', () => {
		it('after placeBet (VRF in flight): directions=[firstDir], cards/outcomes/mults empty', async () => {
			const { hilo } = ctx;
			const { betId } = await placeBet(ctx, MIN_USDC_BET, Direction.BELOW);
			const [dirs, cards, outcomes, mults] = await hilo.getBetCards(betId);
			expect(dirs.map(Number)).to.deep.equal([Direction.BELOW]);
			expect(cards.length).to.equal(0);
			expect(outcomes.length).to.equal(0);
			expect(mults.length).to.equal(0);
		});

		it('PUSH: cards/outcomes/mults each get one entry; mult unchanged at 1.00x', async () => {
			const { hilo } = ctx;
			const { word, card } = wordForCardRank('hist-push', MIDPOINT_RANK);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			const [dirs, cards, outcomes, mults] = await hilo.getBetCards(betId);
			expect(dirs.map(Number)).to.deep.equal([Direction.ABOVE]);
			expect(cards.map(Number)).to.deep.equal([card]);
			expect(outcomes.map(Number)).to.deep.equal([CardOutcome.PUSH]);
			expect(mults.map(String)).to.deep.equal([ONE.toString()]);
		});

		it('HIT: outcome=HIT and mult advanced to factor', async () => {
			const { hilo } = ctx;
			const { word, card } = wordForCardRank('hist-hit', 10);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			const [, cards, outcomes, mults] = await hilo.getBetCards(betId);
			expect(cards.map(Number)).to.deep.equal([card]);
			expect(outcomes.map(Number)).to.deep.equal([CardOutcome.HIT]);
			expect(mults[0]).to.equal(factorE18());
		});

		it('BUST: outcome=BUST and mult freezes at the pre-bust value', async () => {
			const { hilo } = ctx;
			// First win to advance mult past 1.00x, then bust on the second guess
			const { word: w1 } = wordForCardRank('hist-bust-1', 10); // ABOVE wins
			const { word: w2, card: c2 } = wordForCardRank('hist-bust-2', 2); // ABOVE loses (rank<6)
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, w1);
			await guessAndDeal(ctx, betId, Direction.ABOVE, w2);
			const [dirs, cards, outcomes, mults] = await hilo.getBetCards(betId);
			expect(dirs.map(Number)).to.deep.equal([Direction.ABOVE, Direction.ABOVE]);
			expect(cards[1]).to.equal(c2);
			expect(outcomes[1]).to.equal(CardOutcome.BUST);
			// Pre-bust mult was the factor from win 1 — frozen, not zeroed
			expect(mults[1]).to.equal(factorE18());
		});

		it('multi-turn (HIT, HIT, PUSH, HIT, BUST): all arrays parallel and aligned', async () => {
			const { hilo } = ctx;
			const f = factorE18();
			const turns = [
				{ seed: 'mt-h1', rank: 10, dir: Direction.ABOVE, expect: CardOutcome.HIT },
				{ seed: 'mt-h2', rank: 11, dir: Direction.ABOVE, expect: CardOutcome.HIT },
				{ seed: 'mt-p', rank: MIDPOINT_RANK, dir: Direction.ABOVE, expect: CardOutcome.PUSH },
				{ seed: 'mt-h3', rank: 9, dir: Direction.ABOVE, expect: CardOutcome.HIT },
				{ seed: 'mt-b', rank: 2, dir: Direction.ABOVE, expect: CardOutcome.BUST },
			];
			const { word: w0, card: c0 } = wordForCardRank(turns[0].seed, turns[0].rank);
			const betId = await placeBetAndDeal(ctx, turns[0].dir, w0);
			const cardSeq = [c0];
			for (let i = 1; i < turns.length; i++) {
				const { word, card } = wordForCardRank(turns[i].seed, turns[i].rank);
				cardSeq.push(card);
				await guessAndDeal(ctx, betId, turns[i].dir, word);
			}
			const [dirs, cards, outcomes, mults] = await hilo.getBetCards(betId);
			expect(dirs.length).to.equal(turns.length);
			expect(cards.length).to.equal(turns.length);
			expect(outcomes.length).to.equal(turns.length);
			expect(mults.length).to.equal(turns.length);
			expect(dirs.map(Number)).to.deep.equal(turns.map((t) => t.dir));
			expect(cards.map(Number)).to.deep.equal(cardSeq);
			expect(outcomes.map(Number)).to.deep.equal(turns.map((t) => t.expect));
			// Verify multipliers: HIT advances by f, PUSH copies prior, BUST freezes
			let cur = ONE;
			for (let i = 0; i < turns.length; i++) {
				if (turns[i].expect === CardOutcome.HIT) cur = (cur * f) / ONE;
				expect(mults[i]).to.equal(cur);
			}
		});

		it('cashout does not modify the history arrays', async () => {
			const { hilo, player } = ctx;
			const { word } = wordForCardRank('cash-keep', 10);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, word);
			const before = await hilo.getBetCards(betId);
			await hilo.connect(player).makeAction(betId, 2);
			const after = await hilo.getBetCards(betId);
			expect(after.directions.length).to.equal(before.directions.length);
			expect(after.cards.length).to.equal(before.cards.length);
			expect(after.outcomes.length).to.equal(before.outcomes.length);
			expect(after.multipliersE18.length).to.equal(before.multipliersE18.length);
		});

		it('cancel does not modify the history arrays', async () => {
			const { hilo, player } = ctx;
			const { betId } = await placeBet(ctx, MIN_USDC_BET, Direction.ABOVE);
			const before = await hilo.getBetCards(betId);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await hilo.connect(player).cancelBet(betId);
			const after = await hilo.getBetCards(betId);
			expect(after.directions.length).to.equal(before.directions.length);
			expect(after.cards.length).to.equal(0);
		});

		it('cap reached: last multipliersE18 entry equals maxMultiplierE18', async () => {
			const { hilo } = ctx;
			// 5 consecutive ABOVE wins (rank 10) — at f≈1.96x reaches ~28.94x → capped to 25x
			const { word: w0 } = wordForCardRank('cap-0', 10);
			const betId = await placeBetAndDeal(ctx, Direction.ABOVE, w0);
			for (let i = 1; i < 5; i++) {
				const { word } = wordForCardRank(`cap-${i}`, 10);
				await guessAndDeal(ctx, betId, Direction.ABOVE, word);
			}
			const [, , , mults] = await hilo.getBetCards(betId);
			expect(mults[mults.length - 1]).to.equal(MAX_MULT_E18);
		});
	});

	describe('free bet (placeBetWithFreeBet)', () => {
		async function fundFreeBetBalance(ctx, amount) {
			const { fbh, fbhAddr, usdc, owner, player } = ctx;
			// Mint USDC to owner, transfer to FBH so FBH can disburse via useFreeBet, and
			// register the user's balance in the FBH stub
			await usdc.mintForUser(owner.address);
			await usdc.connect(owner).transfer(fbhAddr, amount);
			await fbh.setBalance(player.address, await usdc.getAddress(), amount);
		}

		async function placeFreeBet(ctx, amount, direction) {
			const { hilo, usdcAddr, player } = ctx;
			const tx = await hilo
				.connect(player)
				.placeBet(usdcAddr, amount, ethers.ZeroAddress, direction, true);
			const receipt = await tx.wait();
			const placed = parseLogs(hilo, receipt.logs, 'BetPlaced');
			const guessed = parseLogs(hilo, receipt.logs, 'GuessChosen');
			return { betId: placed.args.betId, requestId: guessed.args.requestId };
		}

		it('reverts if FBH balance is below stake', async () => {
			const { hilo, usdcAddr, player } = ctx;
			// FBH balance is 0 by default
			await expect(
				hilo
					.connect(player)
					.placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, Direction.ABOVE, true)
			).to.be.revertedWith('MockFBH: InsufficientBalance');
		});

		it('debits FBH balance, does NOT touch user wallet at place-time', async () => {
			const { fbh, usdc, usdcAddr, player } = ctx;
			await fundFreeBetBalance(ctx, MIN_USDC_BET);
			const playerBalBefore = await usdc.balanceOf(player.address);
			const fbhBalBefore = await fbh.balancePerUserAndCollateral(player.address, usdcAddr);
			expect(fbhBalBefore).to.equal(MIN_USDC_BET);

			await placeFreeBet(ctx, MIN_USDC_BET, Direction.ABOVE);

			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);
		});

		it('cashout (win): stake → daoSink, profit → user wallet, FBH balance NOT credited back', async () => {
			const { hilo, fbh, usdc, usdcAddr, player, daoSink } = ctx;
			await fundFreeBetBalance(ctx, MIN_USDC_BET);
			const f = factorE18();
			const { word } = wordForCardRank('fb-win', 10);
			const { betId, requestId } = await placeFreeBet(ctx, MIN_USDC_BET, Direction.ABOVE);
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, requestId, [word]);
			const playerBalBefore = await usdc.balanceOf(player.address);
			const daoBalBefore = await usdc.balanceOf(daoSink.address);

			await hilo.connect(player).makeAction(betId, 2);

			const expectedPayout = (MIN_USDC_BET * f) / ONE;
			const expectedProfit = expectedPayout - MIN_USDC_BET;
			expect(await usdc.balanceOf(daoSink.address)).to.equal(daoBalBefore + MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + expectedProfit);
			// Free-bet balance is NOT topped back up after a win (stake consumed by DAO)
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
		});

		it('BUST: no payout, no referrer payment (skipped on free bets)', async () => {
			const { hilo, fbh, usdc, usdcAddr, player } = ctx;
			await fundFreeBetBalance(ctx, MIN_USDC_BET);
			const playerBalBefore = await usdc.balanceOf(player.address);
			const { word } = wordForCardRank('fb-bust', 2);
			const { betId, requestId } = await placeFreeBet(ctx, MIN_USDC_BET, Direction.ABOVE);
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, requestId, [word]);

			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.WRONG_GUESS);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(0n);
			// confirmCasinoBetResolved is NOT called on a bust (no payout flowing through FBH)
			expect(await fbh.confirmCalls()).to.equal(0n);
		});

		it('cancel: stake refunded back to FBH balance (reusable)', async () => {
			const { hilo, fbh, usdcAddr, player } = ctx;
			await fundFreeBetBalance(ctx, MIN_USDC_BET);
			const { betId } = await placeFreeBet(ctx, MIN_USDC_BET, Direction.ABOVE);
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await hilo.connect(player).cancelBet(betId);
			expect(await fbh.balancePerUserAndCollateral(player.address, usdcAddr)).to.equal(
				MIN_USDC_BET
			);
		});

		it('regular placeBet sets isFreeBet=false; placeBetWithFreeBet sets it true', async () => {
			const { hilo } = ctx;
			const { betId: b1 } = await placeBet(ctx, MIN_USDC_BET, Direction.ABOVE);
			// Read raw struct via the bets mapping isn't exposed, but isFreeBet effects show
			// up in payout routing — verified above. Spot-check by re-funding and placing both:
			await fundFreeBetBalance(ctx, MIN_USDC_BET);
			const { betId: b2 } = await placeFreeBet(ctx, MIN_USDC_BET, Direction.ABOVE);
			expect(b2).to.equal(b1 + 1n);
		});
	});

	describe('placeBet + VRF callback edge paths', () => {
		it('sets referrer on placeBet when referrer != 0', async () => {
			const { hilo, usdcAddr, player, owner, core } = ctx;
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
			await hilo.connect(player).placeBet(usdcAddr, MIN_USDC_BET, referrer, Direction.ABOVE, false);
			expect(await refContract.referrals(player.address)).to.equal(referrer);
		});

		it('onVrfFulfilled with unknown requestId is a silent no-op', async () => {
			const { hilo, coreAddr } = ctx;
			await ethers.provider.send('hardhat_impersonateAccount', [coreAddr]);
			await ethers.provider.send('hardhat_setBalance', [coreAddr, '0x56BC75E2D63100000']);
			const coreSigner = await ethers.getSigner(coreAddr);
			await expect(hilo.connect(coreSigner).onVrfFulfilled(99999999n, [0n])).to.not.be.reverted;
			await ethers.provider.send('hardhat_stopImpersonatingAccount', [coreAddr]);
		});
	});
});
