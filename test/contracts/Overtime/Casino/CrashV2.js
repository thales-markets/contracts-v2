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

const SCALE = 1n << 32n;
const HE_E18 = 2n * 10n ** 16n; // 2%

const BetStatus = { NONE: 0, PENDING: 1, RESOLVED: 2, CANCELLED: 3 };

function crashPointE18(word, heE18 = HE_E18) {
	const u = BigInt(word) % SCALE;
	const heSlice = (heE18 * SCALE) / ONE;
	if (u < heSlice) return ONE;
	const numerator = (ONE - heE18) * SCALE;
	const denominator = SCALE - u;
	return numerator / denominator;
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

	const Crash = await ethers.getContractFactory('Crash');
	const crash = await upgrades.deployProxy(Crash, [], { initializer: false });
	const crashAddr = await crash.getAddress();
	await crash.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(crashAddr);
	await core.connect(riskManager).setMaxNetLossPerGameUsd(crashAddr, ethers.parseEther('1000000'));

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, ethers.ZeroAddress);
	await data.setCrash(crashAddr);

	// Bankroll: max target = 1000x with $3 bet → reservation $3000. Need ≥ that
	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		crash,
		crashAddr,
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

async function placeAndFulfill(ctx, amount, targetE18, word) {
	const { crash, vrf, coreAddr, usdcAddr, player } = ctx;
	const tx = await crash.connect(player).placeBet(usdcAddr, amount, targetE18, ethers.ZeroAddress);
	const receipt = await tx.wait();
	const placed = receipt.logs
		.map((l) => {
			try {
				return crash.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	const betId = placed.args.betId;
	await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [word]);
	return betId;
}

describe('CasinoCoreV2 + Crash (Phase 4)', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Initialization', () => {
		it('initializes with 2% house edge and 1000x max target', async () => {
			const { crash, owner, coreAddr } = ctx;
			expect(await crash.owner()).to.equal(owner.address);
			expect(await crash.core()).to.equal(coreAddr);
			expect(await crash.houseEdgeE18()).to.equal(HE_E18);
			expect(await crash.maxTargetE18()).to.equal(1000n * ONE);
		});
	});

	describe('placeBet validation', () => {
		it('reverts on target below 1.00x', async () => {
			const { crash, usdcAddr, player } = ctx;
			await expect(
				crash.connect(player).placeBet(usdcAddr, MIN_USDC_BET, ONE, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(crash, 'InvalidTarget');
		});

		it('reverts on target above maxTarget', async () => {
			const { crash, usdcAddr, player } = ctx;
			await expect(
				crash.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 2000n * ONE, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(crash, 'InvalidTarget');
		});

		it('reserves amount * target in core', async () => {
			const { crash, crashAddr, core, usdc, usdcAddr, player } = ctx;
			const amount = MIN_USDC_BET;
			const target = 5n * ONE; // 5x
			const balBefore = await usdc.balanceOf(player.address);
			await crash.connect(player).placeBet(usdcAddr, amount, target, ethers.ZeroAddress);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - amount);
			const expectedReservation = (amount * target) / ONE;
			expect(await core.reservedProfitPerGame(crashAddr, usdcAddr)).to.equal(expectedReservation);
		});
	});

	describe('VRF resolution', () => {
		it('crash point matches JS derivation', async () => {
			const { crash } = ctx;
			const word = 0xabcdef0123456789n;
			const target = 5n * ONE;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, target, word);
			const base = await crash.getBetBase(betId);
			const expected = crashPointE18(word);
			expect(base.crashPointE18).to.equal(expected);
		});

		it('player wins when crashPoint >= target', async () => {
			const { crash, usdc, player } = ctx;
			// Find a word that produces a high crash point (above target=5x)
			// Use a u value that gives M ≈ 10x
			// M = (1 - HE) * SCALE / (SCALE - u) = 10 → SCALE - u = 0.98 * SCALE / 10 ≈ SCALE * 0.098
			// → u ≈ SCALE * 0.902. So take any word % SCALE ≈ that
			const targetU = (SCALE * 902n) / 1000n; // u that gives M ≈ 10x
			const word = targetU; // word == u (since word < SCALE)
			const target = 5n * ONE;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, target, word);
			const base = await crash.getBetBase(betId);
			expect(base.won).to.be.true;
			// Payout = amount * target / 1e18 = 3 * 5 = 15 USDC
			expect(base.payout).to.equal((MIN_USDC_BET * target) / ONE);
			// Net: -amount + payout = +12
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET + base.payout);
		});

		it('player loses when crashPoint < target', async () => {
			const { crash, usdc, player } = ctx;
			// Pick u in HE slice → instant crash → M = 1 → loses any target > 1
			const word = 0n;
			const target = 5n * ONE;
			const balBefore = await usdc.balanceOf(player.address);
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, target, word);
			const base = await crash.getBetBase(betId);
			expect(base.won).to.be.false;
			expect(base.crashPointE18).to.equal(ONE); // instant crash
			expect(base.payout).to.equal(0n);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore - MIN_USDC_BET);
		});

		it('crash point monotonic in u beyond HE slice', async () => {
			// Larger u → larger crash point
			const heSlice = (HE_E18 * SCALE) / ONE;
			const u1 = heSlice + 1n;
			const u2 = SCALE / 2n;
			const u3 = SCALE - 100n;
			const m1 = crashPointE18(u1);
			const m2 = crashPointE18(u2);
			const m3 = crashPointE18(u3);
			expect(m1).to.be.lt(m2);
			expect(m2).to.be.lt(m3);
		});
	});

	describe('100k Monte Carlo (in-test, fast)', () => {
		// Crash sim is so cheap (single multiplication per round) we run it inline rather
		// than as a separate excluded edge test
		it('realized house edge converges to 2%', async () => {
			const N = 100_000;
			const target = 2n * ONE; // 2x cashout
			let totalStake = 0n;
			let totalPayout = 0n;
			for (let i = 0; i < N; i++) {
				const word = BigInt('0x' + ethers.id(`crash-${i}`).slice(2));
				const cp = crashPointE18(word);
				totalStake += ONE; // $1 per round normalized
				if (cp >= target) totalPayout += target;
			}
			// HE = 1 - payout/stake
			const heMicro = ((totalStake - totalPayout) * 1_000_000n) / totalStake;
			const hePercent = Number(heMicro) / 10_000;
			console.log(
				`    Crash 100k @ target 2x → realized HE = ${hePercent.toFixed(3)}% (theory 2.000%)`
			);
			// 100k * Bernoulli(0.49) variance: SE ≈ sqrt(0.49*0.51/100k)*2 = 0.6%, so 95% CI ±1.2%
			expect(hePercent).to.be.gt(0.5);
			expect(hePercent).to.be.lt(3.5);
		});

		it('realized HE is target-invariant', async () => {
			const N = 50_000;
			for (const targetMul of [2n, 10n, 100n]) {
				const target = targetMul * ONE;
				let stake = 0n,
					payout = 0n;
				for (let i = 0; i < N; i++) {
					const word = BigInt('0x' + ethers.id(`crash-T${targetMul}-${i}`).slice(2));
					const cp = crashPointE18(word);
					stake += ONE;
					if (cp >= target) payout += target;
				}
				const heMicro = ((stake - payout) * 1_000_000n) / stake;
				const hePercent = Number(heMicro) / 10_000;
				console.log(`    target ${targetMul}x → HE = ${hePercent.toFixed(3)}%`);
				// All targets should converge to ~2% HE; tolerance widens for high-variance high-target
				const tolerance = targetMul >= 100n ? 5.0 : 2.0;
				expect(Math.abs(hePercent - 2.0)).to.be.lt(tolerance);
			}
		});
	});

	describe('CasinoDataV2 — Crash records', () => {
		it('returns full Crash record after resolution', async () => {
			const { data, player } = ctx;
			const word = 0n;
			const betId = await placeAndFulfill(ctx, MIN_USDC_BET, 5n * ONE, word);
			const r = await data.getCrashFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(player.address);
			expect(r.status).to.equal(BetStatus.RESOLVED);
		});
	});

	describe('Cancel', () => {
		it('user cancel after timeout refunds amount', async () => {
			const { crash, usdc, usdcAddr, player } = ctx;
			const balBefore = await usdc.balanceOf(player.address);
			const tx = await crash
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, 5n * ONE, ethers.ZeroAddress);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return crash.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = placed.args.betId;
			await time.increase(Number(CANCEL_TIMEOUT) + 1);
			await crash.connect(player).cancelBet(betId);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore);
		});
	});

	describe('Admin', () => {
		it('risk-manager can adjust house edge within bounds', async () => {
			const { crash, riskManager } = ctx;
			await crash.connect(riskManager).setHouseEdge(3n * 10n ** 16n); // 3%
			expect(await crash.houseEdgeE18()).to.equal(3n * 10n ** 16n);
		});

		it('rejects house edge below 2%', async () => {
			const { crash, riskManager } = ctx;
			await expect(
				crash.connect(riskManager).setHouseEdge(1n * 10n ** 16n)
			).to.be.revertedWithCustomError(crash, 'InvalidHouseEdge');
		});

		it('rejects house edge above 5%', async () => {
			const { crash, riskManager } = ctx;
			await expect(
				crash.connect(riskManager).setHouseEdge(6n * 10n ** 16n)
			).to.be.revertedWithCustomError(crash, 'InvalidHouseEdge');
		});
	});
});
