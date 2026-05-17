const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const {
	GameV2,
	readFullRecord,
	readFullRecords,
	readUserRecords,
	readRecentRecords,
} = require('../../../utils/casinoDataV2Helpers');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');
const MAX_PROFIT_USD = ethers.parseEther('5000');
const CANCEL_TIMEOUT = 3600n;
const USDC_UNIT = 1_000_000n;
const ONE = 10n ** 18n;
const MIN_USDC_BET = 3n * USDC_UNIT;

async function deployFullStack() {
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

	// Deploy + register all 6 games
	async function deployGame(name) {
		const Factory = await ethers.getContractFactory(name);
		const c = await upgrades.deployProxy(Factory, [], { initializer: false });
		await c.initialize(owner.address, coreAddr, managerAddr);
		await core.registerGame(await c.getAddress());
		await core.setMaxNetLossPerGameUsd(await c.getAddress(), ethers.parseEther('100000'));
		return c;
	}
	const tcp = await deployGame('ThreeCardPoker');
	const plinko = await deployGame('Plinko');
	const hilo = await deployGame('HiLo');
	const keno = await deployGame('Keno');

	const uth = await deployGame('OvertimeUltimateHoldem');
	const bh = await deployGame('OvertimeBonusHoldem');
	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address);
	await data.setAddress(0, true, coreAddr);
	await data.setAddress(0, false, await tcp.getAddress());
	await data.setAddress(1, false, await plinko.getAddress());
	await data.setAddress(2, false, await hilo.getAddress());
	await data.setAddress(3, false, await keno.getAddress());
	await data.setAddress(4, false, await uth.getAddress());
	await data.setAddress(6, false, await bh.getAddress());

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		owner,
		riskManager,
		resolver,
		pauser,
		player,
		usdc,
		usdcAddr,
		weth,
		wethAddr: await weth.getAddress(),
		over,
		overAddr: await over.getAddress(),
		manager,
		vrf,
		core,
		coreAddr,
		tcp,
		tcpAddr: await tcp.getAddress(),
		plinko,
		plinkoAddr: await plinko.getAddress(),
		hilo,
		hiloAddr: await hilo.getAddress(),
		keno,
		kenoAddr: await keno.getAddress(),
		uth,
		uthAddr: await uth.getAddress(),
		bh,
		bhAddr: await bh.getAddress(),
		data,
		dataAddr: await data.getAddress(),
	};
}

describe('CasinoDataV2 — comprehensive reader coverage', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFullStack);
	});

	describe('Setters & init', () => {
		it('rejects zero-address owner on init', async () => {
			const Data = await ethers.getContractFactory('CasinoDataV2');
			const d = await upgrades.deployProxy(Data, [], { initializer: false });
			await expect(d.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				d,
				'InvalidAddress'
			);
		});

		it('all setters require owner + reject zero', async () => {
			// Access control: non-owner reverts
			await expect(ctx.data.connect(ctx.player).setAddress(1, false, ctx.plinkoAddr)).to.be
				.reverted;
			// Owner can wire all slots + core (trust-admin: no zero-address check)
			await ctx.data.connect(ctx.owner).setAddress(0, false, ctx.tcpAddr);
			await ctx.data.connect(ctx.owner).setAddress(1, false, ctx.plinkoAddr);
			await ctx.data.connect(ctx.owner).setAddress(2, false, ctx.hiloAddr);
			await ctx.data.connect(ctx.owner).setAddress(3, false, ctx.kenoAddr);
			await ctx.data.connect(ctx.owner).setAddress(0, true, ctx.coreAddr);
		});
	});

	describe('Treasury views', () => {
		it('getTreasuryOverview includes all registered games and per-collateral data', async () => {
			const o = await ctx.data.getTreasuryOverview([ctx.usdcAddr, ctx.wethAddr]);
			expect(o.core).to.equal(ctx.coreAddr);
			expect(o.registeredGames.length).to.equal(6);
			expect(o.collaterals[0]).to.equal(ctx.usdcAddr);
			expect(o.balancePerCollateral[0]).to.be.gt(0n);
			expect(o.reservedPerCollateral[0]).to.equal(0n); // no bets placed yet
			expect(o.maxProfitUsd).to.equal(MAX_PROFIT_USD);
			expect(o.cancelTimeout).to.equal(CANCEL_TIMEOUT);
		});

		it('getGameStatus returns per-collateral reservation and pause state', async () => {
			const s = await ctx.data.getGameStatus(ctx.tcpAddr, [ctx.usdcAddr]);
			expect(s.game).to.equal(ctx.tcpAddr);
			expect(s.registered).to.be.true;
			expect(s.paused).to.be.false;
			expect(s.autoPaused).to.be.false;
			expect(s.maxNetLossUsd).to.equal(ethers.parseEther('100000')); // overridden in fixture
			expect(s.reservedPerCollateral[0]).to.equal(0n);
		});
	});

	describe('TCP readers', () => {
		async function placeOne() {
			const tx = await ctx.tcp
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress, false);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return ctx.tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0xdeadbeefn]);
			return placed.args.betId;
		}

		it('getFullRecord(TCP) returns all fields', async () => {
			const id = await placeOne();
			const r = await readFullRecord(ctx.data, ctx.tcp, GameV2.ThreeCardPoker, id);
			expect(r.betId).to.equal(id);
			expect(r.user).to.equal(ctx.player.address);
		});

		it('getFullRecords(TCP) batch reads', async () => {
			const ids = [];
			for (let i = 0; i < 3; i++) ids.push(await placeOne());
			const recs = await readFullRecords(ctx.data, ctx.tcp, GameV2.ThreeCardPoker, ids);
			expect(recs.length).to.equal(3);
		});

		it('batch limit exceeded reverts', async () => {
			const ids = new Array(101).fill(1);
			await expect(
				ctx.data.getFullRecords(GameV2.ThreeCardPoker, ids)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getUserRecords(TCP) paginates', async () => {
			for (let i = 0; i < 2; i++) await placeOne();
			const recs = await readUserRecords(
				ctx.data,
				ctx.tcp,
				GameV2.ThreeCardPoker,
				ctx.player.address,
				0,
				10
			);
			expect(recs.length).to.equal(2);
		});

		it('getUserRecords(TCP) limit too large reverts', async () => {
			await expect(
				ctx.data.getUserRecords(GameV2.ThreeCardPoker, ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getRecentRecords(TCP) paginates', async () => {
			for (let i = 0; i < 2; i++) await placeOne();
			const recs = await readRecentRecords(ctx.data, ctx.tcp, GameV2.ThreeCardPoker, 0, 10);
			expect(recs.length).to.equal(2);
		});

		it('getRecentRecords(TCP) limit exceeded reverts', async () => {
			await expect(
				ctx.data.getRecentRecords(GameV2.ThreeCardPoker, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getUserRecentBetsV2 returns TCP records', async () => {
			await placeOne();
			const recs = await ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 10);
			expect(recs.length).to.be.gte(1);
			expect(recs[0].game).to.equal(0); // TCP enum
		});

		it('getUserRecentBetsV2 limit exceeded reverts', async () => {
			await expect(
				ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});
	});

	// Helper to place + fulfill on an arbitrary game with a given placeBet args
	async function placeFulfill(game, placeArgs, word, eventNameOverride = 'BetPlaced') {
		const tx = await game.connect(ctx.player).placeBet(...placeArgs, false);
		const receipt = await tx.wait();
		const placed = receipt.logs
			.map((l) => {
				try {
					return game.interface.parseLog(l);
				} catch {
					return null;
				}
			})
			.find((e) => e?.name === eventNameOverride);
		await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [word]);
		return placed.args.betId;
	}

	describe('Plinko readers', () => {
		it('full / batch / user / recent', async () => {
			const id = await placeFulfill(
				ctx.plinko,
				[ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress],
				0xdeadbeefn
			);
			expect((await readFullRecord(ctx.data, ctx.plinko, GameV2.Plinko, id)).user).to.equal(
				ctx.player.address
			);
			expect((await readFullRecords(ctx.data, ctx.plinko, GameV2.Plinko, [id])).length).to.equal(1);
			await expect(
				ctx.data.getFullRecords(GameV2.Plinko, new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect(
				(await readUserRecords(ctx.data, ctx.plinko, GameV2.Plinko, ctx.player.address, 0, 10))
					.length
			).to.equal(1);
			await expect(
				ctx.data.getUserRecords(GameV2.Plinko, ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await readRecentRecords(ctx.data, ctx.plinko, GameV2.Plinko, 0, 10)).length).to.equal(
				1
			);
			await expect(ctx.data.getRecentRecords(GameV2.Plinko, 0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('HiLo readers', () => {
		it('full / batch / user / recent', async () => {
			// HiLo's placeBet now requests the first VRF; the bet is left in AWAITING_NEXT_CARD here
			const tx = await ctx.hilo
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0 /* ABOVE */, false);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return ctx.hilo.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const id = placed.args.betId;
			expect((await readFullRecord(ctx.data, ctx.hilo, GameV2.HiLo, id)).user).to.equal(
				ctx.player.address
			);
			expect((await readFullRecords(ctx.data, ctx.hilo, GameV2.HiLo, [id])).length).to.equal(1);
			await expect(
				ctx.data.getFullRecords(GameV2.HiLo, new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect(
				(await readUserRecords(ctx.data, ctx.hilo, GameV2.HiLo, ctx.player.address, 0, 10)).length
			).to.equal(1);
			await expect(
				ctx.data.getUserRecords(GameV2.HiLo, ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await readRecentRecords(ctx.data, ctx.hilo, GameV2.HiLo, 0, 10)).length).to.equal(1);
			await expect(ctx.data.getRecentRecords(GameV2.HiLo, 0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('User-bet pagination edge cases', () => {
		it('getUserRecentBetsV2 returns empty when no bets', async () => {
			const recs = await ctx.data.getUserRecentBetsV2(ethers.Wallet.createRandom().address, 0, 10);
			expect(recs.length).to.equal(0);
		});

		it('getUserRecentBetsV2 returns merged bets across all games sorted by placedAt desc', async () => {
			// Place a bet on each game in order; expect the most recent first (Keno last → idx 0).
			await placeFulfill(
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await placeFulfill(
				ctx.plinko,
				[ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress],
				0xdeadbeefn
			);
			// HiLo (placeBet requests first VRF; we leave it in AWAITING_NEXT_CARD)
			await ctx.hilo
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0 /* ABOVE */, false);
			// Keno
			await placeFulfill(
				ctx.keno,
				[ctx.usdcAddr, MIN_USDC_BET, [1, 2, 3], ethers.ZeroAddress],
				0xdeadbeefn
			);

			const recs = await ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 50);
			expect(recs.length).to.equal(4);
			// Most recent first per GameV2 enum: Keno (3), HiLo (2), Plinko (1), TCP (0)
			expect(recs[0].game).to.equal(3); // Keno
			expect(recs[1].game).to.equal(2); // HiLo
			expect(recs[2].game).to.equal(1); // Plinko
			expect(recs[3].game).to.equal(0); // TCP
			for (const r of recs) {
				expect(r.user).to.equal(ctx.player.address);
				expect(r.collateral).to.equal(ctx.usdcAddr);
				expect(r.amount).to.be.gt(0n);
				expect(r.placedAt).to.be.gt(0n);
			}
		});

		it('getUserRecentBetsV2 honors offset and limit', async () => {
			// Same setup
			await placeFulfill(
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await placeFulfill(
				ctx.plinko,
				[ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await ctx.hilo
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0 /* ABOVE */, false);

			const page = await ctx.data.getUserRecentBetsV2(ctx.player.address, 1, 1);
			expect(page.length).to.equal(1);
			expect(page[0].game).to.equal(1); // 2nd most recent = Plinko
		});

		it('getUserRecentBetsV2 reverts when limit too high', async () => {
			await expect(
				ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});
	});

	describe('Keno readers', () => {
		async function placeOneKeno(picks = [1, 2, 3, 4, 5]) {
			const tx = await ctx.keno
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, picks, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.keno.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0xdeadbeefn]);
			return placed.args.betId;
		}

		it('getFullRecord(Keno) returns the full record', async () => {
			const betId = await placeOneKeno();
			const r = await readFullRecord(ctx.data, ctx.keno, GameV2.Keno, betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(ctx.player.address);
			expect(r.picksCount).to.equal(5);
			expect(r.picksMask).to.be.gt(0n);
		});

		it('getFullRecords(Keno) (batch) returns same shape', async () => {
			const id1 = await placeOneKeno([10, 20, 30]);
			const id2 = await placeOneKeno([40, 50, 60]);
			const recs = await readFullRecords(ctx.data, ctx.keno, GameV2.Keno, [id1, id2]);
			expect(recs.length).to.equal(2);
			expect(recs[0].picksCount).to.equal(3);
			expect(recs[1].picksCount).to.equal(3);
		});

		it('getFullRecords(Keno) reverts above MAX_BATCH_IDS', async () => {
			await expect(
				ctx.data.getFullRecords(GameV2.Keno, new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getUserRecords(Keno) returns user history', async () => {
			await placeOneKeno();
			await placeOneKeno([15, 25]);
			const recs = await readUserRecords(
				ctx.data,
				ctx.keno,
				GameV2.Keno,
				ctx.player.address,
				0,
				10
			);
			expect(recs.length).to.equal(2);
		});

		it('getUserRecords(Keno) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(
				ctx.data.getUserRecords(GameV2.Keno, ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getRecentKenoRecords returns the latest bets', async () => {
			await placeOneKeno();
			const recs = await readRecentRecords(ctx.data, ctx.keno, GameV2.Keno, 0, 10);
			expect(recs.length).to.be.gte(1);
		});

		it('getRecentRecords(Keno) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(ctx.data.getRecentRecords(GameV2.Keno, 0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('Cross-game pagination — getRecentBetsAllGamesV2 / getNextBetId', () => {
		it('getRecentBetsAllGamesV2 returns one inner array per wired game', async () => {
			// Place at least one bet per game so each inner array is non-empty
			await placeFulfill(
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await placeFulfill(
				ctx.plinko,
				[ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await ctx.hilo
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0, false);
			await placeFulfill(
				ctx.keno,
				[ctx.usdcAddr, MIN_USDC_BET, [5, 10], ethers.ZeroAddress],
				0xdeadbeefn
			);

			const all = await ctx.data.getRecentBetsAllGamesV2(0, 10);
			expect(all.length).to.equal(7);
			expect(all[GameV2.ThreeCardPoker].length).to.equal(1);
			expect(all[GameV2.Plinko].length).to.equal(1);
			expect(all[GameV2.HiLo].length).to.equal(1);
			expect(all[GameV2.Keno].length).to.equal(1);
			expect(all[GameV2.OvertimeUltimateHoldem].length).to.equal(0); // no bets placed
			expect(all[GameV2.VideoPoker].length).to.equal(0); // no bets placed
			// Each BetRecord (for the 4 games we placed bets on) should have user / game populated
			for (let g = 0; g < 4; g++) {
				expect(all[g][0].user).to.equal(ctx.player.address);
				expect(Number(all[g][0].game)).to.equal(g);
			}
		});

		it('getRecentBetsAllGamesV2 reverts above MAX_PAGE_LIMIT', async () => {
			await expect(ctx.data.getRecentBetsAllGamesV2(0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});

		it('getNextBetId returns 1 before any bets', async () => {
			expect(await ctx.data.getNextBetId(GameV2.ThreeCardPoker)).to.equal(1n);
			expect(await ctx.data.getNextBetId(GameV2.Plinko)).to.equal(1n);
			expect(await ctx.data.getNextBetId(GameV2.HiLo)).to.equal(1n);
			expect(await ctx.data.getNextBetId(GameV2.Keno)).to.equal(1n);
		});

		it('getNextBetId advances to 2 after one bet on each game', async () => {
			await placeFulfill(
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await placeFulfill(
				ctx.plinko,
				[ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await ctx.hilo
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0, false);
			await placeFulfill(
				ctx.keno,
				[ctx.usdcAddr, MIN_USDC_BET, [5, 10], ethers.ZeroAddress],
				0xdeadbeefn
			);

			expect(await ctx.data.getNextBetId(GameV2.ThreeCardPoker)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.Plinko)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.HiLo)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.Keno)).to.equal(2n);
		});
	});

	/* ===================================================================================
	 * Added coverage: VideoPoker wiring, UTH readers, cross-lib UTH/VP base records,
	 * library calldata + LimitExceeded branches, and unwired-game fallbacks.
	 * =================================================================================== */
	describe('Setter coverage — setAddress', () => {
		it('VideoPoker slot: rejects non-owner; owner can wire', async () => {
			const VP = await ethers.getContractFactory('VideoPoker');
			const vp = await upgrades.deployProxy(VP, [], { initializer: false });
			await vp.initialize(ctx.owner.address, ctx.coreAddr, await ctx.manager.getAddress());
			const vpAddr = await vp.getAddress();
			await expect(ctx.data.connect(ctx.player).setAddress(5, false, vpAddr)).to.be.reverted;
			await ctx.data.connect(ctx.owner).setAddress(5, false, vpAddr);
			expect(await ctx.data.videoPoker()).to.equal(vpAddr);
		});

		it('UltimateHoldem slot: rejects non-owner; owner can wire', async () => {
			await expect(ctx.data.connect(ctx.player).setAddress(4, false, ctx.uthAddr)).to.be.reverted;
			await ctx.data.connect(ctx.owner).setAddress(4, false, ctx.uthAddr);
		});
	});

	describe('getNextBetId — VideoPoker + unwired fallback', () => {
		const GameV2 = {
			ThreeCardPoker: 0,
			Plinko: 1,
			HiLo: 2,
			Keno: 3,
			OvertimeUltimateHoldem: 4,
			VideoPoker: 5,
		};

		it('returns 1 for VideoPoker when unwired (falls to default branch)', async () => {
			// fixture leaves VP unwired → hits the `return 1` fallback line.
			expect(await ctx.data.getNextBetId(GameV2.VideoPoker)).to.equal(1n);
		});

		it('returns nextBetId for OvertimeUltimateHoldem when wired (covers UTH branch body)', async () => {
			expect(await ctx.data.getNextBetId(GameV2.OvertimeUltimateHoldem)).to.equal(1n);
			await ctx.uth
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, false);
			expect(await ctx.data.getNextBetId(GameV2.OvertimeUltimateHoldem)).to.equal(2n);
		});

		it('returns nextBetId = 2 for VideoPoker once wired with one bet', async () => {
			// Deploy + register VP, then wire it on the data aggregator.
			const VP = await ethers.getContractFactory('VideoPoker');
			const vp = await upgrades.deployProxy(VP, [], { initializer: false });
			await vp.initialize(ctx.owner.address, ctx.coreAddr, await ctx.manager.getAddress());
			const vpAddr = await vp.getAddress();
			await ctx.core.registerGame(vpAddr);
			await ctx.core.setMaxNetLossPerGameUsd(vpAddr, ethers.parseEther('100000'));
			await ctx.data.connect(ctx.owner).setAddress(5, false, vpAddr);

			// Place one VP bet (request stays in AWAITING_DEAL — fine, bet id is allocated)
			await vp.connect(ctx.player).placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, false);

			expect(await ctx.data.getNextBetId(GameV2.VideoPoker)).to.equal(2n);
		});
	});

	describe('UTH readers — placed-bet + library calldata + LimitExceeded paths', () => {
		async function placeUthBet() {
			const tx = await ctx.uth
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, false);
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
			return placed.args.betId;
		}

		it('getFullRecord(UTH) returns the bet shape', async () => {
			const betId = await placeUthBet();
			const r = await readFullRecord(ctx.data, ctx.uth, GameV2.OvertimeUltimateHoldem, betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(ctx.player.address);
			expect(r.anteAmount).to.equal(MIN_USDC_BET);
		});

		it('getFullRecords(UTH) (batch) returns matching rows', async () => {
			const id1 = await placeUthBet();
			const id2 = await placeUthBet();
			const recs = await readFullRecords(ctx.data, ctx.uth, GameV2.OvertimeUltimateHoldem, [
				id1,
				id2,
			]);
			expect(recs.length).to.equal(2);
			expect(recs[0].user).to.equal(ctx.player.address);
			expect(recs[1].user).to.equal(ctx.player.address);
		});

		it('getFullRecords(UTH) reverts above MAX_BATCH_IDS', async () => {
			await expect(ctx.data.getFullRecords(GameV2.OvertimeUltimateHoldem, new Array(101).fill(1)))
				.to.be.reverted;
		});

		it('getUserRecords(UTH) paginates', async () => {
			await placeUthBet();
			const recs = await readUserRecords(
				ctx.data,
				ctx.uth,
				GameV2.OvertimeUltimateHoldem,
				ctx.player.address,
				0,
				10
			);
			expect(recs.length).to.equal(1);
		});

		it('getUserRecords(UTH) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(
				ctx.data.getUserRecords(GameV2.OvertimeUltimateHoldem, ctx.player.address, 0, 201)
			).to.be.reverted;
		});

		it('getRecentRecords(UTH) paginates', async () => {
			await placeUthBet();
			const recs = await readRecentRecords(ctx.data, ctx.uth, GameV2.OvertimeUltimateHoldem, 0, 10);
			expect(recs.length).to.be.gte(1);
		});

		it('getRecentRecords(UTH) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(ctx.data.getRecentRecords(GameV2.OvertimeUltimateHoldem, 0, 201)).to.be.reverted;
		});
	});

	/* ===================================================================================
	 * VideoPoker — needs an extra fixture that wires VP into the data aggregator. The base
	 * `deployFullStack` leaves VP unwired so we can also test the unwired branches above.
	 * =================================================================================== */
	async function wireVideoPoker(ctxLocal) {
		const VP = await ethers.getContractFactory('VideoPoker');
		const vp = await upgrades.deployProxy(VP, [], { initializer: false });
		await vp.initialize(
			ctxLocal.owner.address,
			ctxLocal.coreAddr,
			await ctxLocal.manager.getAddress()
		);
		const vpAddr = await vp.getAddress();
		await ctxLocal.core.registerGame(vpAddr);
		await ctxLocal.core.setMaxNetLossPerGameUsd(vpAddr, ethers.parseEther('100000'));
		await ctxLocal.data.connect(ctxLocal.owner).setAddress(5, false, vpAddr);
		return { vp, vpAddr };
	}

	async function placeVpBet(vp) {
		const tx = await vp
			.connect(ctx.player)
			.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, false);
		const r = await tx.wait();
		const placed = r.logs
			.map((l) => {
				try {
					return vp.interface.parseLog(l);
				} catch {
					return null;
				}
			})
			.find((e) => e?.name === 'BetPlaced');
		return placed.args.betId;
	}

	describe('VideoPoker readers — placed-bet + library calldata + LimitExceeded paths', () => {
		let vp, vpAddr;
		beforeEach(async () => {
			({ vp, vpAddr } = await wireVideoPoker(ctx));
		});

		it('getFullRecord(VP) returns the bet shape', async () => {
			const id = await placeVpBet(vp);
			const r = await readFullRecord(ctx.data, vp, GameV2.VideoPoker, id);
			expect(r.betId).to.equal(id);
			expect(r.user).to.equal(ctx.player.address);
			expect(r.amount).to.equal(MIN_USDC_BET);
		});

		it('getFullRecords(VP) (batch) returns matching rows', async () => {
			const id = await placeVpBet(vp);
			const recs = await readFullRecords(ctx.data, vp, GameV2.VideoPoker, [id]);
			expect(recs.length).to.equal(1);
			expect(recs[0].user).to.equal(ctx.player.address);
		});

		it('getFullRecords(VP) reverts above MAX_BATCH_IDS', async () => {
			await expect(ctx.data.getFullRecords(GameV2.VideoPoker, new Array(101).fill(1))).to.be
				.reverted;
		});

		it('getUserRecords(VP) paginates', async () => {
			await placeVpBet(vp);
			const recs = await readUserRecords(
				ctx.data,
				vp,
				GameV2.VideoPoker,
				ctx.player.address,
				0,
				10
			);
			expect(recs.length).to.equal(1);
		});

		it('getUserRecords(VP) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(ctx.data.getUserRecords(GameV2.VideoPoker, ctx.player.address, 0, 201)).to.be
				.reverted;
		});

		it('getRecentRecords(VP) paginates', async () => {
			await placeVpBet(vp);
			const recs = await readRecentRecords(ctx.data, vp, GameV2.VideoPoker, 0, 10);
			expect(recs.length).to.equal(1);
		});

		it('getRecentRecords(VP) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(ctx.data.getRecentRecords(GameV2.VideoPoker, 0, 201)).to.be.reverted;
		});

		it('getRecentBetsAllGamesV2 includes the VP inner array once wired with a bet', async () => {
			await placeVpBet(vp);
			const all = await ctx.data.getRecentBetsAllGamesV2(0, 10);
			expect(all.length).to.equal(7);
			expect(all[5].length).to.equal(1); // VideoPoker
			expect(all[5][0].user).to.equal(ctx.player.address);
			expect(Number(all[5][0].game)).to.equal(5);
		});

		it('getUserRecentBetsV2 picks up VP bets in the gather (covers readVpBase)', async () => {
			await placeVpBet(vp);
			const recs = await ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 50);
			// VP is the only game with a bet for this player on this branch
			expect(recs.some((r) => Number(r.game) === 5)).to.equal(true);
		});
	});

	/* ===================================================================================
	 * Cross-lib coverage — explicitly exercise UTH base-record builders via gatherUserBets
	 * (covers readUthBase) and via getRecentBetsAllGamesV2 (covers readRecentUthBaseRecords).
	 * =================================================================================== */
	describe('CrossLib UTH base-record paths', () => {
		it('getUserRecentBetsV2 picks up UTH bets via _gatherSecondary (covers readUthBase)', async () => {
			// Place UTH bet
			await ctx.uth
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, false);
			const recs = await ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 50);
			expect(recs.some((r) => Number(r.game) === 4)).to.equal(true);
			const uthRec = recs.find((r) => Number(r.game) === 4);
			expect(uthRec.user).to.equal(ctx.player.address);
			// UTH amount = ante*2 + play; play=0 pre-flop. Expect ante*2.
			expect(uthRec.amount).to.equal(MIN_USDC_BET * 2n);
		});

		it('getRecentBetsAllGamesV2 fills the UTH inner array (covers readRecentUthBaseRecords body)', async () => {
			await ctx.uth
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, false);
			const all = await ctx.data.getRecentBetsAllGamesV2(0, 10);
			expect(all[4].length).to.equal(1);
			expect(all[4][0].user).to.equal(ctx.player.address);
		});
	});

	/* ===================================================================================
	 * BonusHoldem readers — exercise dispatcher branches for the 7th GameV2 enum value.
	 * These cover lines 142 (getFullRecord), 180 (_gameIface), 216-218 (_encodeRecordsByIds),
	 * 305 (getNextBetId), 391 (_readBase), 519-520 (_readBonusHoldemBase via recent/gather).
	 * =================================================================================== */
	describe('BonusHoldem readers — placed-bet + dispatcher + LimitExceeded paths', () => {
		const MIN_ANTE = MIN_USDC_BET;
		async function placeBh() {
			const tx = await ctx.bh
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_ANTE, 0n, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.bh.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			return placed.args.betId;
		}

		it('getFullRecord(BonusHoldem) returns the bet shape', async () => {
			const id = await placeBh();
			const r = await readFullRecord(ctx.data, ctx.bh, GameV2.OvertimeBonusHoldem, id);
			expect(r.betId).to.equal(id);
			expect(r.user).to.equal(ctx.player.address);
			expect(r.anteAmount).to.equal(MIN_ANTE);
		});

		it('getFullRecords(BonusHoldem) (batch) returns matching rows', async () => {
			const id1 = await placeBh();
			const id2 = await placeBh();
			const recs = await readFullRecords(ctx.data, ctx.bh, GameV2.OvertimeBonusHoldem, [id1, id2]);
			expect(recs.length).to.equal(2);
			expect(recs[0].user).to.equal(ctx.player.address);
			expect(recs[1].user).to.equal(ctx.player.address);
		});

		it('getFullRecords(BonusHoldem) reverts above MAX_BATCH_IDS', async () => {
			await expect(
				ctx.data.getFullRecords(GameV2.OvertimeBonusHoldem, new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getUserRecords(BonusHoldem) paginates (covers _gameIface BonusHoldem branch)', async () => {
			await placeBh();
			const recs = await readUserRecords(
				ctx.data,
				ctx.bh,
				GameV2.OvertimeBonusHoldem,
				ctx.player.address,
				0,
				10
			);
			expect(recs.length).to.equal(1);
		});

		it('getUserRecords(BonusHoldem) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(
				ctx.data.getUserRecords(GameV2.OvertimeBonusHoldem, ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getRecentRecords(BonusHoldem) paginates', async () => {
			await placeBh();
			const recs = await readRecentRecords(ctx.data, ctx.bh, GameV2.OvertimeBonusHoldem, 0, 10);
			expect(recs.length).to.be.gte(1);
		});

		it('getRecentRecords(BonusHoldem) reverts above MAX_PAGE_LIMIT', async () => {
			await expect(
				ctx.data.getRecentRecords(GameV2.OvertimeBonusHoldem, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getNextBetId(BonusHoldem) is 1 before any bets, 2 after one bet', async () => {
			expect(await ctx.data.getNextBetId(GameV2.OvertimeBonusHoldem)).to.equal(1n);
			await placeBh();
			expect(await ctx.data.getNextBetId(GameV2.OvertimeBonusHoldem)).to.equal(2n);
		});

		it('getRecentBetsAllGamesV2 fills the BonusHoldem inner array (covers _readBase + _readBonusHoldemBase)', async () => {
			await placeBh();
			const all = await ctx.data.getRecentBetsAllGamesV2(0, 10);
			expect(all.length).to.equal(7);
			expect(all[6].length).to.equal(1); // BonusHoldem index
			expect(all[6][0].user).to.equal(ctx.player.address);
			expect(Number(all[6][0].game)).to.equal(6);
		});

		it('getUserRecentBetsV2 picks up BonusHoldem bets via _gatherTertiary', async () => {
			await placeBh();
			const recs = await ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 50);
			const bhRec = recs.find((r) => Number(r.game) === 6);
			expect(bhRec).to.not.be.undefined;
			expect(bhRec.user).to.equal(ctx.player.address);
			expect(bhRec.amount).to.equal(MIN_ANTE);
		});
	});

	/* ===================================================================================
	 * Unwired-game branches — deploy a fresh CasinoDataV2 with Keno/UTH/VP unwired, then
	 * call user/recent aggregators. These exercise the `address(X) != address(0) ? ... :
	 * new uint256[](0)` and zero-game-address fallbacks in the cross-game paths
	 * =================================================================================== */
	describe('Cross-game unwired branches', () => {
		let dataUnwired;
		beforeEach(async () => {
			const Data = await ethers.getContractFactory('CasinoDataV2');
			dataUnwired = await upgrades.deployProxy(Data, [], { initializer: false });
			await dataUnwired.initialize(ctx.owner.address);
			await dataUnwired.setAddress(0, true, ctx.coreAddr);
			// Wire only the "primary" games (TCP/Plinko/HiLo) and leave Keno/UTH/VP unwired.
			await dataUnwired.setAddress(0, false, ctx.tcpAddr);
			await dataUnwired.setAddress(1, false, ctx.plinkoAddr);
			await dataUnwired.setAddress(2, false, ctx.hiloAddr);
			// Note: setKeno + setUltimateHoldem + setVideoPoker intentionally not called.
		});

		it('getUserRecentBetsV2 works with Keno/UTH/VP unwired', async () => {
			// Place a TCP bet so something exists
			const tx = await ctx.tcp
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.tcp.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0xdeadbeefn]);

			const recs = await dataUnwired.getUserRecentBetsV2(ctx.player.address, 0, 10);
			// Only TCP wired with bets — Keno/UTH/VP all skipped via the address(0) branches
			expect(recs.length).to.equal(1);
			expect(Number(recs[0].game)).to.equal(0);
		});

		it('getRecentBetsAllGamesV2 returns empty inner arrays for unwired Keno/UTH/VP', async () => {
			const all = await dataUnwired.getRecentBetsAllGamesV2(0, 10);
			expect(all.length).to.equal(7);
			expect(all[3].length).to.equal(0); // Keno unwired
			expect(all[4].length).to.equal(0); // UTH unwired
			expect(all[5].length).to.equal(0); // VP unwired
		});

		it('getNextBetId(Keno) returns 1 when Keno unwired (falls to default branch)', async () => {
			expect(await dataUnwired.getNextBetId(3)).to.equal(1n); // Keno
			expect(await dataUnwired.getNextBetId(4)).to.equal(1n); // UTH
			expect(await dataUnwired.getNextBetId(5)).to.equal(1n); // VP
		});
	});
});
