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
const MAX_MULT_E18 = 1000n * ONE;

const BetStatus = {
	NONE: 0,
	AWAITING_FIRST_CARD: 1,
	PLAYER_TURN: 2,
	AWAITING_NEXT_CARD: 3,
	RESOLVED: 4,
	CANCELLED: 5,
};
const Outcome = { NONE: 0, CASHED_OUT: 1, WRONG_GUESS: 2 };
const Direction = { HIGHER: 0, LOWER: 1 };

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

// Multiplier factor for a correct guess
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

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setHiLo(hiloAddr);

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
		owner,
		riskManager,
		resolver,
		player,
	};
}

async function placeAndDealFirst(ctx, amount, dealWord) {
	const { hilo, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await hilo.connect(player).placeBet(usdcAddr, amount, ethers.ZeroAddress);
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
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [dealWord]);
	return betId;
}

async function guessAndDeal(ctx, betId, direction, dealWord) {
	const { hilo, vrf, coreAddr, player } = ctx;
	const tx = await hilo.connect(player).guess(betId, direction);
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
	await vrf.fulfillRandomWords(coreAddr, guessed.args.requestId, [dealWord]);
}

describe('CasinoCoreV2 + HiLo (Phase 6)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Initialization', () => {
		it('initializes with 2% house edge and 1000x cap', async () => {
			const { hilo, owner, coreAddr } = ctx;
			expect(await hilo.owner()).to.equal(owner.address);
			expect(await hilo.core()).to.equal(coreAddr);
			expect(await hilo.houseEdgeE18()).to.equal(HE_E18);
			expect(await hilo.maxMultiplierE18()).to.equal(MAX_MULT_E18);
		});
	});

	describe('Multiplier formula', () => {
		it('matches JS for various rank/direction combos', async () => {
			const { hilo } = ctx;
			for (let r = 0; r <= 12; r++) {
				const expectHigher = factorE18(Direction.HIGHER, r);
				const gotHigher = await hilo.multiplierFactorE18(Direction.HIGHER, r);
				expect(gotHigher).to.equal(expectHigher);
				const expectLower = factorE18(Direction.LOWER, r);
				const gotLower = await hilo.multiplierFactorE18(Direction.LOWER, r);
				expect(gotLower).to.equal(expectLower);
			}
		});

		it('returns 0 for invalid extremes (HIGHER at rank 12, LOWER at rank 0)', async () => {
			const { hilo } = ctx;
			expect(await hilo.multiplierFactorE18(Direction.HIGHER, 12)).to.equal(0n);
			expect(await hilo.multiplierFactorE18(Direction.LOWER, 0)).to.equal(0n);
		});

		it('every valid (direction, rank) pair satisfies E[ret] = 1 - HE = 0.98', async () => {
			// Per-guess HE is exactly 2% by formula construction. Verify against the on-chain value
			const { hilo } = ctx;
			for (let r = 0; r <= 12; r++) {
				if (r < 12) {
					const f = await hilo.multiplierFactorE18(Direction.HIGHER, r);
					// E[ret] = P(correct) * f + P(equal) * 1
					//   P(correct) = (12 - r) / 13, P(equal) = 1/13
					//   In e18: ((12-r)/13)*f + (1/13)*1e18 = ((12-r)*f + 1e18) / 13
					const expectedRetE18 = (BigInt(12 - r) * f + ONE) / 13n;
					// Tolerance: integer division rounding accumulates ~13 wei
					expect(expectedRetE18, `HIGHER@${r}`).to.be.gte(ONE - HE_E18 - 13n);
					expect(expectedRetE18, `HIGHER@${r}`).to.be.lte(ONE - HE_E18 + 13n);
				}
				if (r > 0) {
					const f = await hilo.multiplierFactorE18(Direction.LOWER, r);
					const expectedRetE18 = (BigInt(r) * f + ONE) / 13n;
					expect(expectedRetE18, `LOWER@${r}`).to.be.gte(ONE - HE_E18 - 13n);
					expect(expectedRetE18, `LOWER@${r}`).to.be.lte(ONE - HE_E18 + 13n);
				}
			}
		});
	});

	describe('placeBet + first card', () => {
		it('VRF1 deals first card and advances to PLAYER_TURN', async () => {
			const { hilo } = ctx;
			const word = 0xdeadbeefn;
			const expectedCard = Number(word % 52n);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, word);
			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PLAYER_TURN);
			const state = await hilo.getBetState(betId);
			expect(Number(state.currentCard)).to.equal(expectedCard);
			expect(state.currentMultiplierE18).to.equal(ONE);
		});
	});

	describe('guess outcomes', () => {
		it('PUSH on equal rank: status returns to PLAYER_TURN, multiplier unchanged', async () => {
			const { hilo, player } = ctx;
			// Pick a target rank somewhere in middle. 1st card at rank 5, 2nd card at rank 5.
			const { word: w1 } = wordForCardRank('hilo-eq-1', 5);
			const { word: w2 } = wordForCardRank('hilo-eq-2', 5);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await guessAndDeal(ctx, betId, Direction.HIGHER, w2);
			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.PLAYER_TURN);
			const state = await hilo.getBetState(betId);
			expect(state.currentMultiplierE18).to.equal(ONE);
			expect(Number(state.pushCount)).to.equal(1);
		});

		it('correct HIGHER guess multiplies the run', async () => {
			const { hilo } = ctx;
			const { word: w1 } = wordForCardRank('hilo-corr-1', 5);
			const { word: w2 } = wordForCardRank('hilo-corr-2', 9); // rank 9 > 5
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await guessAndDeal(ctx, betId, Direction.HIGHER, w2);
			const state = await hilo.getBetState(betId);
			expect(Number(state.correctCount)).to.equal(1);
			const expectedMult = factorE18(Direction.HIGHER, 5);
			expect(state.currentMultiplierE18).to.equal(expectedMult);
		});

		it('wrong guess loses the run', async () => {
			const { hilo, usdc, player } = ctx;
			const { word: w1 } = wordForCardRank('hilo-wrong-1', 5);
			const { word: w2 } = wordForCardRank('hilo-wrong-2', 2); // rank 2 < 5
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await guessAndDeal(ctx, betId, Direction.HIGHER, w2);
			const base = await hilo.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.WRONG_GUESS);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('rejects HIGHER at rank 12', async () => {
			const { hilo, player } = ctx;
			const { word: w1 } = wordForCardRank('hilo-edge-1', 12);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await expect(
				hilo.connect(player).guess(betId, Direction.HIGHER)
			).to.be.revertedWithCustomError(hilo, 'InvalidDirection');
		});

		it('rejects LOWER at rank 0', async () => {
			const { hilo, player } = ctx;
			const { word: w1 } = wordForCardRank('hilo-edge-2', 0);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await expect(
				hilo.connect(player).guess(betId, Direction.LOWER)
			).to.be.revertedWithCustomError(hilo, 'InvalidDirection');
		});
	});

	describe('cashout', () => {
		it('pays bet * currentMultiplier', async () => {
			const { hilo, usdc, player } = ctx;
			const { word: w1 } = wordForCardRank('hilo-cash-1', 5);
			const { word: w2 } = wordForCardRank('hilo-cash-2', 9);
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await guessAndDeal(ctx, betId, Direction.HIGHER, w2);
			await hilo.connect(player).cashout(betId);
			const expectedMult = factorE18(Direction.HIGHER, 5);
			const expectedPayout = (MIN_USDC_BET * expectedMult) / ONE;
			expect(await usdc.balanceOf(player.address)).to.equal(
				balBefore - MIN_USDC_BET + expectedPayout
			);
		});

		it('cashout immediately after first card pays 1x (full refund minus 0%)', async () => {
			const { hilo, usdc, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, 0xabcdn);
			await hilo.connect(player).cashout(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	describe('Cancel', () => {
		it('user cancel after timeout from AWAITING_FIRST_CARD refunds amount', async () => {
			const { hilo, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await hilo.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ethers.ZeroAddress);
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
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await hilo.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	describe('CasinoDataV2 — HiLo records', () => {
		it('returns full HiLo record', async () => {
			const { hilo, data, player } = ctx;
			const { word: w1 } = wordForCardRank('hilo-data-1', 5);
			const betId = await placeAndDealFirst(ctx, MIN_USDC_BET, w1);
			await hilo.connect(player).cashout(betId);
			const r = await data.getHiLoFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.outcome).to.equal(Outcome.CASHED_OUT);
		});
	});
});
