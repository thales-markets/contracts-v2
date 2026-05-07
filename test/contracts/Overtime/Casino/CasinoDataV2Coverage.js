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
		await core
			.connect(riskManager)
			.setMaxNetLossPerGameUsd(await c.getAddress(), ethers.parseEther('100000'));
		return c;
	}
	const tcp = await deployGame('ThreeCardPoker');
	const holdem = await deployGame('OvertimeHoldem');
	const plinko = await deployGame('Plinko');
	const crash = await deployGame('Crash');
	const mines = await deployGame('Mines');
	const hilo = await deployGame('HiLo');

	const Data = await ethers.getContractFactory('CasinoDataV2');
	const data = await upgrades.deployProxy(Data, [], { initializer: false });
	await data.initialize(owner.address, coreAddr, await tcp.getAddress());
	await data.setOvertimeHoldem(await holdem.getAddress());
	await data.setPlinko(await plinko.getAddress());
	await data.setCrash(await crash.getAddress());
	await data.setMines(await mines.getAddress());
	await data.setHiLo(await hilo.getAddress());

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
		crash,
		crashAddr: await crash.getAddress(),
		mines,
		minesAddr: await mines.getAddress(),
		hilo,
		hiloAddr: await hilo.getAddress(),
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
				'setCrash',
				'setMines',
				'setHiLo',
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
			await ctx.data.connect(ctx.owner).setCrash(ctx.crashAddr);
			await ctx.data.connect(ctx.owner).setMines(ctx.minesAddr);
			await ctx.data.connect(ctx.owner).setHiLo(ctx.hiloAddr);
			await ctx.data.connect(ctx.owner).setCore(ctx.coreAddr);
		});
	});

	describe('Treasury views', () => {
		it('getTreasuryOverview includes all 6 registered games and per-collateral data', async () => {
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
				[ctx.usdcAddr, MIN_USDC_BET, 8, 0, ethers.ZeroAddress],
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

	describe('Crash readers', () => {
		it('full / batch / user / recent', async () => {
			const target = 5n * ONE;
			const id = await placeFulfill(
				ctx.crash,
				[ctx.usdcAddr, MIN_USDC_BET, target, ethers.ZeroAddress],
				0xdeadbeefn
			);
			expect((await ctx.data.getCrashFullRecord(id)).user).to.equal(ctx.player.address);
			expect((await ctx.data.getCrashFullRecords([id])).length).to.equal(1);
			await expect(
				ctx.data.getCrashFullRecords(new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getUserCrashRecords(ctx.player.address, 0, 10)).length).to.equal(1);
			await expect(
				ctx.data.getUserCrashRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getRecentCrashRecords(0, 10)).length).to.equal(1);
			await expect(ctx.data.getRecentCrashRecords(0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('Mines readers', () => {
		it('full / batch / user / recent', async () => {
			const id = await placeFulfill(
				ctx.mines,
				[ctx.usdcAddr, MIN_USDC_BET, 3, ethers.ZeroAddress],
				0xdeadbeefn
			);
			expect((await ctx.data.getMinesFullRecord(id)).user).to.equal(ctx.player.address);
			expect((await ctx.data.getMinesFullRecords([id])).length).to.equal(1);
			await expect(
				ctx.data.getMinesFullRecords(new Array(101).fill(1))
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getUserMinesRecords(ctx.player.address, 0, 10)).length).to.equal(1);
			await expect(
				ctx.data.getUserMinesRecords(ctx.player.address, 0, 201)
			).to.be.revertedWithCustomError(ctx.data, 'LimitExceeded');
			expect((await ctx.data.getRecentMinesRecords(0, 10)).length).to.equal(1);
			await expect(ctx.data.getRecentMinesRecords(0, 201)).to.be.revertedWithCustomError(
				ctx.data,
				'LimitExceeded'
			);
		});
	});

	describe('HiLo readers', () => {
		it('full / batch / user / recent', async () => {
			const id = await placeFulfill(
				ctx.hilo,
				[ctx.usdcAddr, MIN_USDC_BET, ethers.ZeroAddress],
				0xdeadbeefn
			);
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
	});
});
