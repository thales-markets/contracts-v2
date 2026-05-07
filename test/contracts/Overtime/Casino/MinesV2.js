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

const BetStatus = { NONE: 0, AWAITING_DEAL: 1, ACTIVE: 2, RESOLVED: 3, CANCELLED: 4 };
const Outcome = { NONE: 0, CASHED_OUT: 1, HIT_MINE: 2 };

function jsMultiplierE18(mines, safeCount, heE18 = HE_E18, capE18 = MAX_MULT_E18) {
	if (safeCount === 0) return 0n;
	if (safeCount > 25 - mines) return capE18;
	let m = ONE - heE18;
	for (let i = 0; i < safeCount; i++) {
		m = (m * BigInt(25 - i)) / BigInt(25 - mines - i);
		if (m >= capE18) return capE18;
	}
	return m;
}

// Mirror the contract's _shuffleMines so we can predict mine positions for tests
function jsShuffleMines(word, mineCount) {
	const deck = Array.from({ length: 25 }, (_, i) => i);
	let cursor = BigInt(word);
	let chunksLeft = 16;
	for (let i = 0; i < mineCount; i++) {
		if (chunksLeft === 0) {
			cursor = BigInt(
				ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [cursor]))
			);
			chunksLeft = 16;
		}
		const remaining = BigInt(25 - i);
		const j = i + Number((cursor & 0xffffn) % remaining);
		cursor >>= 16n;
		chunksLeft--;
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	let mask = 0;
	for (let i = 0; i < mineCount; i++) {
		mask |= 1 << deck[i];
	}
	return { mineIndices: deck.slice(0, mineCount), mineMask: mask };
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

	const Mines = await ethers.getContractFactory('Mines');
	const mines = await upgrades.deployProxy(Mines, [], { initializer: false });
	const minesAddr = await mines.getAddress();
	await mines.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(minesAddr);
	await core.connect(riskManager).setMaxNetLossPerGameUsd(minesAddr, ethers.parseEther('1000000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setMines(minesAddr);

	// Bankroll: max mult 1000x with $3 = $3000 reservation
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		mines,
		minesAddr,
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

async function placeAndDeal(ctx, amount, mineCount, dealWord) {
	const { mines, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await mines.connect(player).placeBet(usdcAddr, amount, mineCount, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return mines.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [dealWord]);
	return betId;
}

describe('CasinoCoreV2 + Mines (Phase 5)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Initialization', () => {
		it('initializes with 2% house edge and 1000x cap', async () => {
			const { mines, owner, coreAddr } = ctx;
			expect(await mines.owner()).to.equal(owner.address);
			expect(await mines.core()).to.equal(coreAddr);
			expect(await mines.houseEdgeE18()).to.equal(HE_E18);
			expect(await mines.maxMultiplierE18()).to.equal(MAX_MULT_E18);
		});
	});

	describe('Multiplier formula', () => {
		it('matches JS for known cases', async () => {
			const { mines } = ctx;
			// mines=1, safeCount=1: 0.98 * 25/24 ≈ 1.0208333...
			const m = await mines.multiplierE18(1, 1);
			const expected = jsMultiplierE18(1, 1);
			expect(m).to.equal(expected);
		});

		it('grows with safeCount', async () => {
			const { mines } = ctx;
			let prev = await mines.multiplierE18(3, 1);
			for (let k = 2; k <= 22; k++) {
				const m = await mines.multiplierE18(3, k);
				expect(m).to.be.gte(prev);
				prev = m;
			}
		});

		it('grows with mineCount at fixed safeCount', async () => {
			const { mines } = ctx;
			let prev = await mines.multiplierE18(1, 5);
			for (let mc = 2; mc <= 19; mc++) {
				const m = await mines.multiplierE18(mc, 5);
				expect(m).to.be.gte(prev);
				prev = m;
			}
		});

		it('caps at maxMultiplierE18', async () => {
			const { mines } = ctx;
			// mines=12, safeCount=12 → theoretical mult is huge
			const m = await mines.multiplierE18(12, 12);
			expect(m).to.equal(MAX_MULT_E18);
		});

		it('all (mines, safeCount) combos imply ≥2% theoretical house edge', async () => {
			// HE at cashout point k = 1 - prob(reach k) * mult(k)
			//   = 1 - (C(25-mines, k)/C(25, k)) * (1-HE) * (C(25, k)/C(25-mines, k))
			//   = 1 - (1-HE) = HE = 2%
			// This holds exactly by construction, but verify numerically that the on-chain
			// multiplier (with cap) maintains ≥2% HE for every reachable cashout point
			const { mines } = ctx;
			for (let mc = 1; mc <= 19; mc++) {
				for (let sc = 1; sc <= 25 - mc; sc++) {
					const mult = await mines.multiplierE18(mc, sc);
					// Probability of reaching this cashout point (numerator/denominator integers)
					let probNum = 1n,
						probDen = 1n;
					for (let i = 0; i < sc; i++) {
						probNum *= BigInt(25 - mc - i);
						probDen *= BigInt(25 - i);
					}
					// Expected return per stake at this cashout = prob * mult (in 1e18 scale)
					const expectedReturnE18 = (probNum * mult) / probDen;
					// HE = 1e18 - expectedReturn
					expect(expectedReturnE18, `mines=${mc} sc=${sc}`).to.be.lte(ONE - HE_E18 + 1n);
				}
			}
		});
	});

	describe('placeBet validation', () => {
		it('reverts on invalid mine count (0 or 25+)', async () => {
			const { mines, usdcAddr, player } = ctx;
			await expect(
				mines.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(mines, 'InvalidMineCount');
			await expect(
				mines.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 25, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(mines, 'InvalidMineCount');
		});

		it('reserves amount * maxMultiplier', async () => {
			const { mines, minesAddr, core, usdcAddr, player } = ctx;
			await mines.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 3, ethers.ZeroAddress);
			expect(await core.reservedProfitPerGame(minesAddr, usdcAddr)).to.equal(
				(MIN_USDC_BET * MAX_MULT_E18) / ONE
			);
		});
	});

	describe('VRF + reveal + cashout', () => {
		it('VRF commits the mine mask matching JS prediction', async () => {
			const { mines } = ctx;
			const word = 0xdeadbeefn;
			const mc = 3;
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, mc, word);
			const base = await mines.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.ACTIVE);
			const expected = jsShuffleMines(word, mc);
			const onChainMask = await mines.getMineMask(betId);
			expect(Number(onChainMask)).to.equal(expected.mineMask);
		});

		it('safe reveal increments safeCount; multiplier returned in event', async () => {
			const { mines, player } = ctx;
			const mc = 3;
			const word = 0xdeadbeefn;
			const { mineIndices } = jsShuffleMines(word, mc);
			const safeIndex = [...Array(25).keys()].find((i) => !mineIndices.includes(i));
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, mc, word);
			const tx = await mines.connect(player).revealTile(betId, safeIndex);
			const receipt = await tx.wait();
			const ev = receipt.logs
				.map((l) => {
					try {
						return mines.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'TileRevealed');
			expect(ev.args.wasMine).to.be.false;
			expect(Number(ev.args.safeCount)).to.equal(1);
			const expectedMult = jsMultiplierE18(mc, 1);
			expect(ev.args.currentMultiplierE18).to.equal(expectedMult);
		});

		it('hitting a mine ends the game with payout 0', async () => {
			const { mines, usdc, player } = ctx;
			const mc = 5;
			const word = 0xcafe1234n;
			const { mineIndices } = jsShuffleMines(word, mc);
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, mc, word);
			await mines.connect(player).revealTile(betId, mineIndices[0]);
			const base = await mines.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.HIT_MINE);
			expect(base.payout).to.equal(0n);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('cashout pays bet * multiplier(safeCount, mineCount)', async () => {
			const { mines, usdc, player } = ctx;
			const mc = 3;
			const word = 0xa1b2c3d4n;
			const { mineIndices } = jsShuffleMines(word, mc);
			const safeTiles = [...Array(25).keys()].filter((i) => !mineIndices.includes(i));
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, mc, word);
			// Reveal 5 safe tiles
			for (let i = 0; i < 5; i++) {
				await mines.connect(player).revealTile(betId, safeTiles[i]);
			}
			await mines.connect(player).cashout(betId);
			const base = await mines.getBetBase(betId);
			expect(base.status).to.equal(BetStatus.RESOLVED);
			expect(base.outcome).to.equal(Outcome.CASHED_OUT);
			const expectedMult = jsMultiplierE18(mc, 5);
			const expectedPayout = (MIN_USDC_BET * expectedMult) / ONE;
			expect(base.payout).to.equal(expectedPayout);
			// Net: -bet + payout
			expect(await usdc.balanceOf(player.address)).to.equal(
				balBefore - MIN_USDC_BET + expectedPayout
			);
		});

		it('cannot reveal already-revealed tile', async () => {
			const { mines, player } = ctx;
			const mc = 3;
			const word = 0xa1b2c3d4n;
			const { mineIndices } = jsShuffleMines(word, mc);
			const safeIndex = [...Array(25).keys()].find((i) => !mineIndices.includes(i));
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, mc, word);
			await mines.connect(player).revealTile(betId, safeIndex);
			await expect(
				mines.connect(player).revealTile(betId, safeIndex)
			).to.be.revertedWithCustomError(mines, 'TileAlreadyRevealed');
		});

		it('cashout with safeCount=0 reverts', async () => {
			const { mines, player } = ctx;
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, 3, 0xdeadbeefn);
			await expect(mines.connect(player).cashout(betId)).to.be.revertedWithCustomError(
				mines,
				'InvalidBetStatus'
			);
		});
	});

	describe('Cancel', () => {
		it('user cancel after timeout from AWAITING_DEAL refunds amount', async () => {
			const { mines, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await mines
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, 3, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return mines.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await mines.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	describe('CasinoDataV2 — Mines records', () => {
		it('returns full Mines record after resolution', async () => {
			const { mines, data, player } = ctx;
			const word = 0xa1b2c3d4n;
			const { mineIndices } = jsShuffleMines(word, 3);
			const safeIndex = [...Array(25).keys()].find((i) => !mineIndices.includes(i));
			const betId = await placeAndDeal(ctx, MIN_USDC_BET, 3, word);
			await mines.connect(player).revealTile(betId, safeIndex);
			await mines.connect(player).cashout(betId);
			const r = await data.getMinesFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.outcome).to.equal(Outcome.CASHED_OUT);
			expect(Number(r.mineMask)).to.equal(jsShuffleMines(word, 3).mineMask);
		});
	});
});
