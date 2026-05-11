const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

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
	const holdem = await deployGame('OvertimeHoldem');
	const plinko = await deployGame('Plinko');
	const hilo = await deployGame('HiLo');
	const keno = await deployGame('Keno');

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, await tcp.getAddress());
	await data.setOvertimeHoldem(await holdem.getAddress());
	await data.setPlinko(await plinko.getAddress());
	await data.setHiLo(await hilo.getAddress());
	await data.setKeno(await keno.getAddress());

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
		holdem,
		holdemAddr: await holdem.getAddress(),
		plinko,
		plinkoAddr: await plinko.getAddress(),
		hilo,
		hiloAddr: await hilo.getAddress(),
		keno,
		kenoAddr: await keno.getAddress(),
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
			await expect(
				d.initialize(ethers.ZeroAddress, ctx.coreAddr, ctx.tcpAddr)
			).to.be.revertedWithCustomError(d, 'InvalidAddress');
		});

		it('all setters require owner + reject zero', async () => {
			const setters = [
				'setCore',
				'setThreeCardPoker',
				'setOvertimeHoldem',
				'setPlinko',
				'setHiLo',
				'setKeno',
			];
			for (const s of setters) {
				await expect(ctx.data.connect(ctx.player)[s](ctx.tcpAddr)).to.be.reverted;
				await expect(
					ctx.data.connect(ctx.owner)[s](ethers.ZeroAddress)
				).to.be.revertedWithCustomError(ctx.data, 'InvalidAddress');
			}
			// owner can set them
			await ctx.data.connect(ctx.owner).setThreeCardPoker(ctx.tcpAddr);
			await ctx.data.connect(ctx.owner).setOvertimeHoldem(ctx.holdemAddr);
			await ctx.data.connect(ctx.owner).setPlinko(ctx.plinkoAddr);
			await ctx.data.connect(ctx.owner).setHiLo(ctx.hiloAddr);
			await ctx.data.connect(ctx.owner).setKeno(ctx.kenoAddr);
			await ctx.data.connect(ctx.owner).setCore(ctx.coreAddr);
		});
	});

	describe('Treasury views', () => {
		it('getTreasuryOverview includes all 5 registered games and per-collateral data', async () => {
			const o = await ctx.data.getTreasuryOverview([ctx.usdcAddr, ctx.wethAddr]);
			expect(o.core).to.equal(ctx.coreAddr);
			expect(o.registeredGames.length).to.equal(5);
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress);
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

		it('getThreeCardPokerFullRecord returns all fields', async () => {
			const id = await placeOne();
			const r = await ctx.data.getThreeCardPokerFullRecord(id);
			expect(r.betId).to.equal(id);
			expect(r.user).to.equal(ctx.player.address);
		});

		it('getThreeCardPokerFullRecords batch reads', async () => {
			const ids = [];
			for (let i = 0; i < 3; i++) ids.push(await placeOne());
			const recs = await ctx.data.getThreeCardPokerFullRecords(ids);
			expect(recs.length).to.equal(3);
		});

		it('batch limit exceeded reverts', async () => {
			const ids = new Array(101).fill(1);
			await expect(ctx.data.getThreeCardPokerFullRecords(ids)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});

		it('getUserThreeCardPokerRecords paginates', async () => {
			for (let i = 0; i < 2; i++) await placeOne();
			const recs = await ctx.data.getUserThreeCardPokerRecords(ctx.player.address, 0, 10);
			expect(recs.length).to.equal(2);
		});

		it('getUserThreeCardPokerRecords limit too large reverts', async () => {
			await expect(
				ctx.data.getUserThreeCardPokerRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getRecentThreeCardPokerRecords paginates', async () => {
			for (let i = 0; i < 2; i++) await placeOne();
			const recs = await ctx.data.getRecentThreeCardPokerRecords(0, 10);
			expect(recs.length).to.equal(2);
		});

		it('getRecentThreeCardPokerRecords limit exceeded reverts', async () => {
			await expect(ctx.data.getRecentThreeCardPokerRecords(0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
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
		const tx = await game.connect(ctx.player).placeBet(...placeArgs);
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

	describe("Hold'em readers", () => {
		it('getOvertimeHoldemFullRecord/full batch/user/recent readers', async () => {
			const id = await placeFulfill(
				ctx.holdem,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			expect((await ctx.data.getOvertimeHoldemFullRecord(id)).user).to.equal(ctx.player.address);
			expect((await ctx.data.getOvertimeHoldemFullRecords([id])).length).to.equal(1);
			await expect(
				ctx.data.getOvertimeHoldemFullRecords(new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect(
				(await ctx.data.getUserOvertimeHoldemRecords(ctx.player.address, 0, 10)).length
			).to.equal(1);
			await expect(
				ctx.data.getUserOvertimeHoldemRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getRecentOvertimeHoldemRecords(0, 10)).length).to.equal(1);
			await expect(ctx.data.getRecentOvertimeHoldemRecords(0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('Plinko readers', () => {
		it('full / batch / user / recent', async () => {
			const id = await placeFulfill(
				ctx.plinko,
				[ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress],
				0xdeadbeefn
			);
			expect((await ctx.data.getPlinkoFullRecord(id)).user).to.equal(ctx.player.address);
			expect((await ctx.data.getPlinkoFullRecords([id])).length).to.equal(1);
			await expect(
				ctx.data.getPlinkoFullRecords(new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getUserPlinkoRecords(ctx.player.address, 0, 10)).length).to.equal(1);
			await expect(
				ctx.data.getUserPlinkoRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getRecentPlinkoRecords(0, 10)).length).to.equal(1);
			await expect(ctx.data.getRecentPlinkoRecords(0, 201)).to.be.revertedWithCustomError(
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0 /* ABOVE */);
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
			expect((await ctx.data.getHiLoFullRecord(id)).user).to.equal(ctx.player.address);
			expect((await ctx.data.getHiLoFullRecords([id])).length).to.equal(1);
			await expect(
				ctx.data.getHiLoFullRecords(new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getUserHiLoRecords(ctx.player.address, 0, 10)).length).to.equal(1);
			await expect(
				ctx.data.getUserHiLoRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getRecentHiLoRecords(0, 10)).length).to.equal(1);
			await expect(ctx.data.getRecentHiLoRecords(0, 201)).to.be.revertedWithCustomError(
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

		it('getUserRecentBetsV2 returns merged bets across all 5 games sorted by placedAt desc', async () => {
			// Place a bet on each game in order; expect the most recent first (Keno last → idx 0).
			await placeFulfill(
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await placeFulfill(
				ctx.holdem,
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0 /* ABOVE */);
			// Keno
			await placeFulfill(
				ctx.keno,
				[ctx.usdcAddr, MIN_USDC_BET, [1, 2, 3], ethers.ZeroAddress],
				0xdeadbeefn
			);

			const recs = await ctx.data.getUserRecentBetsV2(ctx.player.address, 0, 50);
			expect(recs.length).to.equal(5);
			// Most recent first per GameV2 enum: Keno (4), HiLo (3), Plinko (2), Hold'em (1), TCP (0)
			expect(recs[0].game).to.equal(4); // Keno
			expect(recs[1].game).to.equal(3); // HiLo
			expect(recs[2].game).to.equal(2); // Plinko
			expect(recs[3].game).to.equal(1); // OvertimeHoldem
			expect(recs[4].game).to.equal(0); // TCP
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0 /* ABOVE */);

			const page = await ctx.data.getUserRecentBetsV2(ctx.player.address, 1, 1);
			expect(page.length).to.equal(1);
			expect(page[0].game).to.equal(2); // 2nd most recent = Plinko
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, picks, ethers.ZeroAddress);
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

		it('getKenoFullRecord returns the full record', async () => {
			const betId = await placeOneKeno();
			const r = await ctx.data.getKenoFullRecord(betId);
			expect(r.betId).to.equal(betId);
			expect(r.user).to.equal(ctx.player.address);
			expect(r.picksCount).to.equal(5);
			expect(r.picksMask).to.be.gt(0n);
		});

		it('getKenoFullRecords (batch) returns same shape', async () => {
			const id1 = await placeOneKeno([10, 20, 30]);
			const id2 = await placeOneKeno([40, 50, 60]);
			const recs = await ctx.data.getKenoFullRecords([id1, id2]);
			expect(recs.length).to.equal(2);
			expect(recs[0].picksCount).to.equal(3);
			expect(recs[1].picksCount).to.equal(3);
		});

		it('getKenoFullRecords reverts above MAX_BATCH_IDS', async () => {
			await expect(
				ctx.data.getKenoFullRecords(new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getUserKenoRecords returns user history', async () => {
			await placeOneKeno();
			await placeOneKeno([15, 25]);
			const recs = await ctx.data.getUserKenoRecords(ctx.player.address, 0, 10);
			expect(recs.length).to.equal(2);
		});

		it('getUserKenoRecords reverts above MAX_PAGE_LIMIT', async () => {
			await expect(
				ctx.data.getUserKenoRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
		});

		it('getRecentKenoRecords returns the latest bets', async () => {
			await placeOneKeno();
			const recs = await ctx.data.getRecentKenoRecords(0, 10);
			expect(recs.length).to.be.gte(1);
		});

		it('getRecentKenoRecords reverts above MAX_PAGE_LIMIT', async () => {
			await expect(ctx.data.getRecentKenoRecords(0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('Cross-game pagination — getRecentBetsAllGamesV2 / getNextBetId', () => {
		const GameV2 = {
			ThreeCardPoker: 0,
			OvertimeHoldem: 1,
			Plinko: 2,
			HiLo: 3,
			Keno: 4,
		};

		it('getRecentBetsAllGamesV2 returns one inner array per wired game', async () => {
			// Place at least one bet per game so each inner array is non-empty
			await placeFulfill(
				ctx.tcp,
				[ctx.usdcAddr, MIN_USDC_BET, 0n, ethers.ZeroAddress],
				0xdeadbeefn
			);
			await placeFulfill(
				ctx.holdem,
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0);
			await placeFulfill(
				ctx.keno,
				[ctx.usdcAddr, MIN_USDC_BET, [5, 10], ethers.ZeroAddress],
				0xdeadbeefn
			);

			const all = await ctx.data.getRecentBetsAllGamesV2(0, 10);
			expect(all.length).to.equal(5);
			expect(all[GameV2.ThreeCardPoker].length).to.equal(1);
			expect(all[GameV2.OvertimeHoldem].length).to.equal(1);
			expect(all[GameV2.Plinko].length).to.equal(1);
			expect(all[GameV2.HiLo].length).to.equal(1);
			expect(all[GameV2.Keno].length).to.equal(1);
			// Each BetRecord should have user / game / amount populated
			for (let g = 0; g < 5; g++) {
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
			expect(await ctx.data.getNextBetId(GameV2.OvertimeHoldem)).to.equal(1n);
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
				ctx.holdem,
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
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress, 0);
			await placeFulfill(
				ctx.keno,
				[ctx.usdcAddr, MIN_USDC_BET, [5, 10], ethers.ZeroAddress],
				0xdeadbeefn
			);

			expect(await ctx.data.getNextBetId(GameV2.ThreeCardPoker)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.OvertimeHoldem)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.Plinko)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.HiLo)).to.equal(2n);
			expect(await ctx.data.getNextBetId(GameV2.Keno)).to.equal(2n);
		});
	});
});
