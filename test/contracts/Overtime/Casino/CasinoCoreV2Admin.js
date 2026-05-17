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

async function deployFixture() {
	const [
		owner,
		riskManager,
		resolver,
		pauser,
		player,
		freeBetsHolderStub,
		brokenReferralsEoa,
		brokenPriceFeedEoa,
		brokenFbhEoa,
	] = await ethers.getSigners();

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

	// Register a "test game" — use Plinko as a real registered game we can drive through
	const Plinko = await ethers.getContractFactory('Plinko');
	const plinko = await upgrades.deployProxy(Plinko, [], { initializer: false });
	const plinkoAddr = await plinko.getAddress();
	await plinko.initialize(owner.address, coreAddr, managerAddr);
	await core.registerGame(plinkoAddr);

	await usdc.mintForUser(owner.address);
	await usdc.transfer(coreAddr, 4_000n * USDC_UNIT);
	await usdc.transfer(player.address, 500n * USDC_UNIT);
	await usdc.connect(player).approve(coreAddr, ethers.MaxUint256);

	return {
		core,
		coreAddr,
		plinko,
		plinkoAddr,
		manager,
		vrf,
		usdc,
		usdcAddr,
		weth,
		wethAddr: await weth.getAddress(),
		over,
		overAddr: await over.getAddress(),
		priceFeed,
		owner,
		riskManager,
		resolver,
		pauser,
		player,
		freeBetsHolderStub,
		brokenReferralsEoa,
		brokenPriceFeedEoa,
		brokenFbhEoa,
	};
}

describe('CasinoCoreV2 — admin + edge cases', () => {
	let ctx;
	beforeEach(async () => {
		ctx = await loadFixture(deployFixture);
	});

	describe('Initialization revert paths', () => {
		async function fresh() {
			const Core = await ethers.getContractFactory('CasinoCoreV2');
			return await upgrades.deployProxy(Core, [], { initializer: false });
		}
		const ZA = ethers.ZeroAddress;
		const goodCol = (ctx) => ({
			usdc: ctx.usdcAddr,
			weth: ctx.wethAddr,
			over: ctx.overAddr,
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		});
		const goodVrf = {
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		};

		it('rejects zero addresses across CoreAddresses', async () => {
			const f = await fresh();
			const fields = ['owner', 'manager', 'priceFeed', 'vrfCoordinator', 'freeBetsHolder'];
			for (const field of fields) {
				const core = {
					owner: ctx.owner.address,
					manager: await ctx.manager.getAddress(),
					priceFeed: await ctx.priceFeed.getAddress(),
					vrfCoordinator: await ctx.vrf.getAddress(),
					freeBetsHolder: ctx.freeBetsHolderStub.address,
					referrals: ZA,
				};
				core[field] = ZA;
				const f2 = await fresh();
				await expect(
					f2.initialize(core, goodCol(ctx), MAX_PROFIT_USD, CANCEL_TIMEOUT, goodVrf)
				).to.be.revertedWithCustomError(f2, 'InvalidAddress');
			}
		});

		it('rejects zero collateral addresses', async () => {
			for (const field of ['usdc', 'weth', 'over']) {
				const f = await fresh();
				const col = goodCol(ctx);
				col[field] = ZA;
				await expect(
					f.initialize(
						{
							owner: ctx.owner.address,
							manager: await ctx.manager.getAddress(),
							priceFeed: await ctx.priceFeed.getAddress(),
							vrfCoordinator: await ctx.vrf.getAddress(),
							freeBetsHolder: ctx.freeBetsHolderStub.address,
							referrals: ZA,
						},
						col,
						MAX_PROFIT_USD,
						CANCEL_TIMEOUT,
						goodVrf
					)
				).to.be.revertedWithCustomError(f, 'InvalidAddress');
			}
		});

		it('rejects zero maxProfitUsd', async () => {
			const f = await fresh();
			await expect(
				f.initialize(
					{
						owner: ctx.owner.address,
						manager: await ctx.manager.getAddress(),
						priceFeed: await ctx.priceFeed.getAddress(),
						vrfCoordinator: await ctx.vrf.getAddress(),
						freeBetsHolder: ctx.freeBetsHolderStub.address,
						referrals: ZA,
					},
					goodCol(ctx),
					0,
					CANCEL_TIMEOUT,
					goodVrf
				)
			).to.be.revertedWithCustomError(f, 'InvalidAmount');
		});

		it('rejects cancelTimeout below MIN_CANCEL_TIMEOUT', async () => {
			const f = await fresh();
			await expect(
				f.initialize(
					{
						owner: ctx.owner.address,
						manager: await ctx.manager.getAddress(),
						priceFeed: await ctx.priceFeed.getAddress(),
						vrfCoordinator: await ctx.vrf.getAddress(),
						freeBetsHolder: ctx.freeBetsHolderStub.address,
						referrals: ZA,
					},
					goodCol(ctx),
					MAX_PROFIT_USD,
					29,
					goodVrf
				)
			).to.be.revertedWithCustomError(f, 'InvalidAmount');
		});

		it('rejects zero callbackGasLimit', async () => {
			const f = await fresh();
			await expect(
				f.initialize(
					{
						owner: ctx.owner.address,
						manager: await ctx.manager.getAddress(),
						priceFeed: await ctx.priceFeed.getAddress(),
						vrfCoordinator: await ctx.vrf.getAddress(),
						freeBetsHolder: ctx.freeBetsHolderStub.address,
						referrals: ZA,
					},
					goodCol(ctx),
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					{ ...goodVrf, callbackGasLimit: 0 }
				)
			).to.be.revertedWithCustomError(f, 'InvalidAmount');
		});

		it('accepts non-zero referrals at init', async () => {
			const f = await fresh();
			await f.initialize(
				{
					owner: ctx.owner.address,
					manager: await ctx.manager.getAddress(),
					priceFeed: await ctx.priceFeed.getAddress(),
					vrfCoordinator: await ctx.vrf.getAddress(),
					freeBetsHolder: ctx.freeBetsHolderStub.address,
					referrals: ctx.brokenReferralsEoa.address,
				},
				goodCol(ctx),
				MAX_PROFIT_USD,
				CANCEL_TIMEOUT,
				goodVrf
			);
			expect(await f.referrals()).to.equal(ctx.brokenReferralsEoa.address);
		});
	});

	describe('Game registry', () => {
		it('rejects registerGame on zero address', async () => {
			await expect(ctx.core.registerGame(ethers.ZeroAddress)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidAddress'
			);
		});

		it('deregisterGame removes an unused game', async () => {
			const fake = ethers.Wallet.createRandom().address;
			await ctx.core.registerGame(fake);
			expect(await ctx.core.isGameRegistered(fake)).to.be.true;
			await ctx.core.deregisterGame(fake);
			expect(await ctx.core.isGameRegistered(fake)).to.be.false;
			const games = await ctx.core.getRegisteredGames();
			expect(games).to.not.include(fake);
		});

		it('deregisterGame reverts when reservations exist', async () => {
			const { core, plinko, plinkoAddr, player, usdcAddr } = ctx;
			await plinko.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			await expect(core.deregisterGame(plinkoAddr)).to.be.revertedWithCustomError(
				core,
				'GameHasReservations'
			);
		});

		it('deregisterGame reverts on unregistered game', async () => {
			const fake = ethers.Wallet.createRandom().address;
			await expect(ctx.core.deregisterGame(fake)).to.be.revertedWithCustomError(
				ctx.core,
				'GameNotRegistered'
			);
		});

		it('non-owner cannot deregister', async () => {
			await expect(ctx.core.connect(ctx.player).deregisterGame(ctx.plinkoAddr)).to.be.reverted;
		});

		it('deregister with swap-and-pop: middle-of-list game removed cleanly', async () => {
			const a = ethers.Wallet.createRandom().address;
			const b = ethers.Wallet.createRandom().address;
			const c = ethers.Wallet.createRandom().address;
			await ctx.core.registerGame(a);
			await ctx.core.registerGame(b);
			await ctx.core.registerGame(c);
			// Now list is [plinko, a, b, c]; deregister b (middle)
			await ctx.core.deregisterGame(b);
			const games = await ctx.core.getRegisteredGames();
			expect(games).to.not.include(b);
			expect(games).to.include(a);
			expect(games).to.include(c);
			expect(games).to.include(ctx.plinkoAddr);
		});

		it('setCollateralConfig adds new collateral to enumerable list; remove removes from list', async () => {
			const { core } = ctx;
			const before = await core.getSupportedCollaterals();
			expect(before.length).to.equal(3); // usdc, weth, over

			const fake = ethers.Wallet.createRandom().address;
			const KEY = ethers.encodeBytes32String('XYZ');
			await core.setCollateralConfig(fake, KEY, true);
			const afterAdd = await core.getSupportedCollaterals();
			expect(afterAdd.length).to.equal(4);
			expect(afterAdd).to.include(fake);

			// Re-set with same isSupported=true → no duplicate add
			await core.setCollateralConfig(fake, KEY, true);
			expect((await core.getSupportedCollaterals()).length).to.equal(4);

			// Remove
			await core.setCollateralConfig(fake, KEY, false);
			const afterRemove = await core.getSupportedCollaterals();
			expect(afterRemove.length).to.equal(3);
			expect(afterRemove).to.not.include(fake);

			// Re-set with isSupported=false again → no underflow
			await expect(core.setCollateralConfig(fake, KEY, false)).to.not.be.reverted;
			expect((await core.getSupportedCollaterals()).length).to.equal(3);
		});

		it('getSupportedCollaterals reflects setCollateralConfig changes (swap-and-pop ordering)', async () => {
			const { core } = ctx;
			const a = ethers.Wallet.createRandom().address;
			const b = ethers.Wallet.createRandom().address;
			await core.setCollateralConfig(a, ethers.encodeBytes32String('A'), true);
			await core.setCollateralConfig(b, ethers.encodeBytes32String('B'), true);
			let list = await core.getSupportedCollaterals();
			expect(list.length).to.equal(5);
			// Remove a (mid-list) → swap-and-pop puts b in a's slot
			await core.setCollateralConfig(a, ethers.encodeBytes32String('A'), false);
			list = await core.getSupportedCollaterals();
			expect(list).to.not.include(a);
			expect(list).to.include(b);
			expect(list.length).to.equal(4);
		});
	});

	describe('Per-game state setters', () => {
		it('owner-or-pauser can setGamePaused; emits event', async () => {
			const { core, plinkoAddr, pauser } = ctx;
			await expect(core.connect(pauser).setGamePaused(plinkoAddr, true))
				.to.emit(core, 'GamePauseChanged')
				.withArgs(plinkoAddr, true);
			expect(await core.gamePaused(plinkoAddr)).to.be.true;
			// no-op when already in target state (no event)
			await core.connect(pauser).setGamePaused(plinkoAddr, true);
			await core.connect(pauser).setGamePaused(plinkoAddr, false);
		});

		it('non-pauser cannot setGamePaused', async () => {
			await expect(ctx.core.connect(ctx.player).setGamePaused(ctx.plinkoAddr, true)).to.be.reverted;
		});

		it('owner can setMaxNetLossPerGameUsd', async () => {
			const { core, plinkoAddr } = ctx;
			await expect(core.setMaxNetLossPerGameUsd(plinkoAddr, 555n))
				.to.emit(core, 'MaxNetLossPerGameUsdChanged')
				.withArgs(plinkoAddr, 555n);
			expect(await core.maxNetLossPerGameUsd(plinkoAddr)).to.equal(555n);
		});

		it('non-owner (incl. risk-manager) cannot setMaxNetLossPerGameUsd', async () => {
			await expect(ctx.core.connect(ctx.player).setMaxNetLossPerGameUsd(ctx.plinkoAddr, 1n)).to.be
				.reverted;
			await expect(ctx.core.connect(ctx.riskManager).setMaxNetLossPerGameUsd(ctx.plinkoAddr, 1n)).to
				.be.reverted;
		});

		it('owner can setDefaultMaxNetLossPerGameUsd', async () => {
			const { core } = ctx;
			await expect(core.setDefaultMaxNetLossPerGameUsd(2000n * ONE))
				.to.emit(core, 'DefaultMaxNetLossPerGameUsdChanged')
				.withArgs(2000n * ONE);
			expect(await core.defaultMaxNetLossPerGameUsd()).to.equal(2000n * ONE);
		});

		it('rejects zero default max net loss', async () => {
			await expect(ctx.core.setDefaultMaxNetLossPerGameUsd(0)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidAmount'
			);
		});

		it('resetGameCircuitBreaker requires risk-manager', async () => {
			await expect(ctx.core.connect(ctx.player).resetGameCircuitBreaker(ctx.plinkoAddr)).to.be
				.reverted;
		});

		it('gameInactiveReason returns expected enum values', async () => {
			const { core, plinkoAddr, pauser, riskManager } = ctx;
			expect(await core.gameInactiveReason(ethers.Wallet.createRandom().address)).to.equal(1); // NOT_REGISTERED
			expect(await core.gameInactiveReason(plinkoAddr)).to.equal(0); // NONE (active)
			await core.connect(pauser).setGamePaused(plinkoAddr, true);
			expect(await core.gameInactiveReason(plinkoAddr)).to.equal(3); // GAME_PAUSED
			await core.connect(pauser).setGamePaused(plinkoAddr, false);
			await core.connect(pauser).setPausedByRole(true);
			expect(await core.gameInactiveReason(plinkoAddr)).to.equal(2); // TREASURY_PAUSED
		});
	});

	describe('Risk + collateral + addresses + VRF setters', () => {
		it('setRiskParams: pass nonzero updates, zero skips', async () => {
			const { core } = ctx;
			await core.setRiskParams(7777n, 0);
			expect(await core.maxProfitUsd()).to.equal(7777n);
			expect(await core.cancelTimeout()).to.equal(CANCEL_TIMEOUT); // unchanged
			await core.setRiskParams(0, 60);
			expect(await core.maxProfitUsd()).to.equal(7777n); // unchanged
			expect(await core.cancelTimeout()).to.equal(60n);
		});

		it('setRiskParams rejects cancelTimeout < min', async () => {
			await expect(ctx.core.setRiskParams(0, 5)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidAmount'
			);
		});

		it('non-owner (incl. risk-manager) cannot setRiskParams', async () => {
			await expect(ctx.core.connect(ctx.player).setRiskParams(1n, 0)).to.be.reverted;
			await expect(ctx.core.connect(ctx.riskManager).setRiskParams(1n, 0)).to.be.reverted;
		});

		it('setMaxProfitUsdOverride sets/clears the per-game override; effectiveMaxProfitUsd reflects it', async () => {
			const { core, plinkoAddr } = ctx;
			// Default: no override → effective = global
			expect(await core.maxProfitUsdOverride(plinkoAddr)).to.equal(0n);
			expect(await core.effectiveMaxProfitUsd(plinkoAddr)).to.equal(MAX_PROFIT_USD);

			// Set override → effective = override
			const overrideValue = 9999n * ONE;
			await expect(core.setMaxProfitUsdOverride(plinkoAddr, overrideValue))
				.to.emit(core, 'MaxProfitUsdOverrideChanged')
				.withArgs(plinkoAddr, overrideValue);
			expect(await core.maxProfitUsdOverride(plinkoAddr)).to.equal(overrideValue);
			expect(await core.effectiveMaxProfitUsd(plinkoAddr)).to.equal(overrideValue);

			// Clear with 0 → effective = global again
			await core.setMaxProfitUsdOverride(plinkoAddr, 0);
			expect(await core.maxProfitUsdOverride(plinkoAddr)).to.equal(0n);
			expect(await core.effectiveMaxProfitUsd(plinkoAddr)).to.equal(MAX_PROFIT_USD);
		});

		it('setMaxProfitUsdOverride rejects zero address', async () => {
			await expect(
				ctx.core.setMaxProfitUsdOverride(ethers.ZeroAddress, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidAddress');
		});

		it('non-owner (incl. risk-manager) cannot setMaxProfitUsdOverride', async () => {
			await expect(ctx.core.connect(ctx.player).setMaxProfitUsdOverride(ctx.plinkoAddr, 1n)).to.be
				.reverted;
			await expect(ctx.core.connect(ctx.riskManager).setMaxProfitUsdOverride(ctx.plinkoAddr, 1n)).to
				.be.reverted;
		});

		it('effectiveMaxProfitUsd works for unregistered games too (returns global)', async () => {
			// effectiveMaxProfitUsd is just a view that reads override-or-global. Not gated on
			// registration — useful for the dapp to query before a game is wired up
			const fake = ethers.Wallet.createRandom().address;
			expect(await ctx.core.effectiveMaxProfitUsd(fake)).to.equal(MAX_PROFIT_USD);
		});

		it('per-game override actually loosens placeBet: Plinko 8-HIGH (29x) at $20 bet', async () => {
			const { core, plinko, plinkoAddr, player, usdcAddr } = ctx;
			// At $300 global, $20 × 28 = $560 worst case → fails. With $5000 override → passes
			await core.setRiskParams(300n * ONE, 0);
			const amount = 20n * USDC_UNIT;
			await expect(
				plinko.connect(player).placeBet(usdcAddr, amount, 2, ethers.ZeroAddress, false)
			).to.be.revertedWithCustomError(plinko, 'MaxProfitExceeded');
			await core.setMaxProfitUsdOverride(plinkoAddr, 5000n * ONE);
			await expect(plinko.connect(player).placeBet(usdcAddr, amount, 2, ethers.ZeroAddress, false))
				.to.not.be.reverted;
		});

		it('setCollateralConfig adds/removes collateral', async () => {
			const { core } = ctx;
			const NEW_KEY = ethers.encodeBytes32String('XYZ');
			const fake = ethers.Wallet.createRandom().address;
			await expect(core.setCollateralConfig(fake, NEW_KEY, true))
				.to.emit(core, 'CollateralConfigChanged')
				.withArgs(fake, NEW_KEY, true);
			expect(await core.supportedCollateral(fake)).to.be.true;
			expect(await core.priceFeedKeyPerCollateral(fake)).to.equal(NEW_KEY);
			await core.setCollateralConfig(fake, NEW_KEY, false);
			expect(await core.supportedCollateral(fake)).to.be.false;
		});

		it('setCollateralConfig rejects zero address', async () => {
			await expect(
				ctx.core.setCollateralConfig(ethers.ZeroAddress, ethers.ZeroHash, true)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidAddress');
		});

		it('setAddresses skips zero, updates non-zero', async () => {
			const { core, owner, manager } = ctx;
			const newRef = ethers.Wallet.createRandom().address;
			await expect(
				core
					.connect(owner)
					.setAddresses(
						ethers.ZeroAddress,
						ethers.ZeroAddress,
						ethers.ZeroAddress,
						ethers.ZeroAddress,
						newRef
					)
			).to.emit(core, 'AddressesChanged');
			expect(await core.referrals()).to.equal(newRef);
			// manager unchanged
			expect(await core.manager()).to.equal(await manager.getAddress());
		});

		it('non-owner cannot setAddresses', async () => {
			await expect(
				ctx.core
					.connect(ctx.player)
					.setAddresses(
						ethers.ZeroAddress,
						ethers.ZeroAddress,
						ethers.ZeroAddress,
						ethers.ZeroAddress,
						ethers.ZeroAddress
					)
			).to.be.reverted;
		});

		it('setVrfConfig validates non-zero subId/keyHash/cb', async () => {
			const { core, owner } = ctx;
			const newKey = ethers.encodeBytes32String('VRF');
			await expect(
				core.connect(owner).setVrfConfig(0, newKey, 500_000, 1, true)
			).to.be.revertedWithCustomError(core, 'InvalidAmount');
			await expect(
				core.connect(owner).setVrfConfig(2, ethers.ZeroHash, 500_000, 1, true)
			).to.be.revertedWithCustomError(core, 'InvalidAmount');
			await expect(
				core.connect(owner).setVrfConfig(2, newKey, 0, 1, true)
			).to.be.revertedWithCustomError(core, 'InvalidAmount');
			await expect(core.connect(owner).setVrfConfig(2, newKey, 500_000, 1, true)).to.emit(
				core,
				'VrfConfigChanged'
			);
			expect(await core.subscriptionId()).to.equal(2);
			expect(await core.nativePayment()).to.be.true;
		});

		it('non-owner cannot setVrfConfig', async () => {
			await expect(
				ctx.core
					.connect(ctx.player)
					.setVrfConfig(2, ethers.encodeBytes32String('K'), 500_000, 1, true)
			).to.be.reverted;
		});
	});

	describe('Treasury pause', () => {
		it('setPausedByRole sets and emits, no-op on same value', async () => {
			const { core, pauser } = ctx;
			await expect(core.connect(pauser).setPausedByRole(true))
				.to.emit(core, 'PauseChanged')
				.withArgs(true);
			expect(await core.paused()).to.be.true;
			// no event when already in target state
			const tx = await core.connect(pauser).setPausedByRole(true);
			const receipt = await tx.wait();
			expect(receipt.logs.length).to.equal(0);
		});

		it('non-pauser cannot pause', async () => {
			await expect(ctx.core.connect(ctx.player).setPausedByRole(true)).to.be.reverted;
		});
	});

	describe('withdrawCollateral', () => {
		it('owner can withdraw available; recipient defaults to owner', async () => {
			const { core, owner, usdc, usdcAddr } = ctx;
			const balBefore = await usdc.balanceOf(owner.address);
			await core.connect(owner).withdrawCollateral(usdcAddr, ethers.ZeroAddress, 100n * USDC_UNIT);
			expect(await usdc.balanceOf(owner.address)).to.equal(balBefore + 100n * USDC_UNIT);
		});

		it('reverts when amount exceeds available (reserved blocks)', async () => {
			const { core, owner, usdc, usdcAddr, plinko, player } = ctx;
			// Reserve some bankroll via a placeBet
			await plinko.connect(player).placeBet(usdcAddr, MIN_USDC_BET, 2, ethers.ZeroAddress, false); // HIGH risk (29x reservation)
			const balance = await usdc.balanceOf(await core.getAddress());
			const reserved = await core.reservedProfitPerCollateral(usdcAddr);
			const available = balance - reserved;
			// Try to withdraw more than available
			await expect(
				core.connect(owner).withdrawCollateral(usdcAddr, ethers.ZeroAddress, available + 1n)
			).to.be.revertedWithCustomError(core, 'InsufficientAvailableLiquidity');
		});

		it('non-owner cannot withdraw', async () => {
			await expect(
				ctx.core.connect(ctx.player).withdrawCollateral(ctx.usdcAddr, ethers.ZeroAddress, 1n)
			).to.be.reverted;
		});

		it('reverts when amount > balance', async () => {
			await expect(
				ctx.core
					.connect(ctx.owner)
					.withdrawCollateral(ctx.usdcAddr, ctx.owner.address, 100_000n * USDC_UNIT)
			).to.be.revertedWithCustomError(ctx.core, 'InsufficientAvailableLiquidity');
		});
	});

	describe('Game-facing methods — gating + edge cases', () => {
		// For tests that need msg.sender to be a registered game, we register an EOA as a fake game
		// and impersonate it. hardhat_setBalance lets us fund the impersonated address without
		// needing the contract to have a receive() function

		async function impersonateRegisteredGame() {
			const fakeGame = ethers.Wallet.createRandom().address;
			await ctx.core.registerGame(fakeGame);
			const signer = await ethers.getImpersonatedSigner(fakeGame);
			await hre.network.provider.send('hardhat_setBalance', [
				fakeGame,
				'0xDE0B6B3A7640000', // 1 ETH
			]);
			return signer;
		}

		it('rawFulfillRandomWords gated to coordinator only', async () => {
			await expect(
				ctx.core.connect(ctx.player).rawFulfillRandomWords(1, [42])
			).to.be.revertedWithCustomError(ctx.core, 'InvalidSender');
		});

		it('rawFulfillRandomWords with unknown requestId reverts', async () => {
			const vrfAddr = await ctx.vrf.getAddress();
			const vrfImp = await ethers.getImpersonatedSigner(vrfAddr);
			await hre.network.provider.send('hardhat_setBalance', [vrfAddr, '0xDE0B6B3A7640000']);
			await expect(
				ctx.core.connect(vrfImp).rawFulfillRandomWords(99999, [42])
			).to.be.revertedWithCustomError(ctx.core, 'VrfRequestUnknown');
		});

		it('non-registered caller cannot pullFromUser', async () => {
			await expect(
				ctx.core.connect(ctx.player).pullFromUser(ctx.player.address, ctx.usdcAddr, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'GameNotRegistered');
		});

		it('non-registered caller cannot reserveOrRevert', async () => {
			await expect(
				ctx.core.connect(ctx.player).reserveOrRevert(ctx.usdcAddr, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'GameNotRegistered');
		});

		it('non-registered caller cannot releaseReservation', async () => {
			await expect(
				ctx.core.connect(ctx.player).releaseReservation(ctx.usdcAddr, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'GameNotRegistered');
		});

		it('non-registered caller cannot recordSettlement', async () => {
			await expect(
				ctx.core.connect(ctx.player).recordSettlement(ctx.usdcAddr, 1n, 0n)
			).to.be.revertedWithCustomError(ctx.core, 'GameNotRegistered');
		});

		it('non-registered caller cannot setReferrer', async () => {
			await expect(
				ctx.core.connect(ctx.player).setReferrer(ctx.player.address, ctx.player.address)
			).to.be.revertedWithCustomError(ctx.core, 'GameNotRegistered');
		});

		it('reserveOrRevert with zero amount is no-op', async () => {
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).reserveOrRevert(ctx.usdcAddr, 0n)).to.not.be.reverted;
		});

		it('reserveOrRevert allows cumulative over-commitment (per-bet check only)', async () => {
			// V2 is fractionally reserved by design: each reservation is checked against the
			// current balance independently. Stack two reservations whose sum > balance, the
			// second still succeeds. Withdraw protection (separately tested) blocks admin drains.
			const { core, usdcAddr } = ctx;
			const game = await impersonateRegisteredGame();
			const balance = await ctx.usdc.balanceOf(await core.getAddress());
			// Each reservation is balance - 1 wei (just under). Two of them sum to ~2× balance.
			const r = balance - 1n;
			await expect(core.connect(game).reserveOrRevert(usdcAddr, r)).to.not.be.reverted;
			await expect(core.connect(game).reserveOrRevert(usdcAddr, r)).to.not.be.reverted;
			expect(await core.reservedProfitPerCollateral(usdcAddr)).to.equal(2n * r);
			// Sanity: a third reservation of balance+1 (single bet exceeds balance) DOES still revert
			await expect(
				core.connect(game).reserveOrRevert(usdcAddr, balance + 1n)
			).to.be.revertedWithCustomError(core, 'InsufficientAvailableLiquidity');
		});

		it('reserveOrRevert rejects a single bet whose own reservation exceeds balance', async () => {
			const { core, usdcAddr } = ctx;
			const game = await impersonateRegisteredGame();
			const balance = await ctx.usdc.balanceOf(await core.getAddress());
			await expect(
				core.connect(game).reserveOrRevert(usdcAddr, balance + 1n)
			).to.be.revertedWithCustomError(core, 'InsufficientAvailableLiquidity');
			// State rolled back on revert
			expect(await core.reservedProfitPerCollateral(usdcAddr)).to.equal(0n);
		});

		it('withdrawCollateral still uses cumulative reserved + pending (not per-bet)', async () => {
			// Even though placement allows cumulative over-commitment, the admin withdraw path
			// continues to use the full cumulative liability so it can't drain bankroll under
			// in-flight bets. Stack two reservations exceeding balance, confirm withdraw is gated.
			const { core, usdc, usdcAddr, owner } = ctx;
			const game = await impersonateRegisteredGame();
			const balance = await usdc.balanceOf(await core.getAddress());
			await core.connect(game).reserveOrRevert(usdcAddr, balance - 1n);
			await core.connect(game).reserveOrRevert(usdcAddr, balance - 1n);
			// cumulative reserved = 2·(balance-1) > balance → no withdraw should succeed
			await expect(
				core.connect(owner).withdrawCollateral(usdcAddr, owner.address, 1n)
			).to.be.revertedWithCustomError(core, 'InsufficientAvailableLiquidity');
		});

		it('releaseReservation underflow reverts with UnderReservation', async () => {
			const game = await impersonateRegisteredGame();
			await expect(
				ctx.core.connect(game).releaseReservation(ctx.usdcAddr, 999n)
			).to.be.revertedWithCustomError(ctx.core, 'UnderReservation');
		});

		it('releaseReservation with zero amount is no-op', async () => {
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).releaseReservation(ctx.usdcAddr, 0n)).to.not.be.reverted;
		});

		it('pullFromUser rejects unsupported collateral', async () => {
			const game = await impersonateRegisteredGame();
			await expect(
				ctx.core.connect(game).pullFromUser(ctx.player.address, ethers.ZeroAddress, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidCollateral');
		});

		it('pullFromUser rejects zero amount', async () => {
			const game = await impersonateRegisteredGame();
			await expect(
				ctx.core.connect(game).pullFromUser(ctx.player.address, ctx.usdcAddr, 0n)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidAmount');
		});

		it('useFreeBet rejects unsupported collateral', async () => {
			const game = await impersonateRegisteredGame();
			await expect(
				ctx.core.connect(game).useFreeBet(ctx.player.address, ethers.ZeroAddress, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidCollateral');
		});

		it('useFreeBet rejects zero amount', async () => {
			const game = await impersonateRegisteredGame();
			await expect(
				ctx.core.connect(game).useFreeBet(ctx.player.address, ctx.usdcAddr, 0n)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidAmount');
		});

		it('reserveOrRevert reverts on unsupported collateral', async () => {
			const game = await impersonateRegisteredGame();
			await expect(
				ctx.core.connect(game).reserveOrRevert(ethers.ZeroAddress, 1n)
			).to.be.revertedWithCustomError(ctx.core, 'InvalidCollateral');
		});

		it('requestRandomWords rejects zero numWords', async () => {
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).requestRandomWords(0)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidAmount'
			);
		});

		it('payOut amount=0 is no-op', async () => {
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).payOut(ctx.player.address, ctx.usdcAddr, 0n, false, 0n))
				.to.not.be.reverted;
		});

		it('payReferrer with no referrals contract is no-op', async () => {
			// Default fixture has referrals = address(0); just verify no revert
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).payReferrer(ctx.player.address, ctx.usdcAddr, 100n)).to
				.not.be.reverted;
		});

		it('setReferrer with no referrals contract is no-op', async () => {
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).setReferrer(ctx.player.address, ctx.player.address)).to
				.not.be.reverted;
		});

		it('setReferrer with zero referrer is no-op', async () => {
			const game = await impersonateRegisteredGame();
			await expect(ctx.core.connect(game).setReferrer(ethers.ZeroAddress, ctx.player.address)).to
				.not.be.reverted;
		});
	});

	describe('Hardened referrals try/catch (with broken Mock)', () => {
		async function pointAtBrokenReferrals() {
			const Broken = await ethers.getContractFactory('MockBrokenReferrals');
			const broken = await Broken.deploy();
			const brokenAddr = await broken.getAddress();
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					brokenAddr
				);
			return brokenAddr;
		}

		it('setReferrer with broken referrals: silent (placeBet still succeeds)', async () => {
			await pointAtBrokenReferrals();
			const fakeReferrer = ethers.Wallet.createRandom().address;
			// placeBet should NOT revert despite broken referrals
			await expect(
				ctx.plinko.connect(ctx.player).placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, fakeReferrer, false)
			).to.not.be.reverted;
		});

		it('payReferrer with broken referrals: bet still resolves (no cancel surface)', async () => {
			await pointAtBrokenReferrals();
			const tx = await ctx.plinko
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return ctx.plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			// 0x0F → low byte 0b00001111 → 4 set bits → slot 4 → 0.5x → losing path → payReferrer
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0x0fn]);
			const base = await ctx.plinko.getBetBase(placed.args.betId);
			expect(base.status).to.equal(2); // RESOLVED — not stuck despite broken referrals
		});

		it('payReferrer at the getReferrerFee step: catches mid-call revert', async () => {
			// MockBrokenReferrals reverts on every method, including referrals(). So getReferrerFee
			// is never reached. To hit that branch, deploy a partial mock that returns a non-zero
			// referrer but reverts on getReferrerFee
			const PartialMock = await ethers.getContractFactory('MockPartialReferrals');
			const m = await PartialMock.deploy();
			const mAddr = await m.getAddress();
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					mAddr
				);
			const tx = await ctx.plinko
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return ctx.plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0x0fn]);
			expect((await ctx.plinko.getBetBase(placed.args.betId)).status).to.equal(2);
		});

		it('payReferrer success path (working referrals + ERC20 transfer)', async () => {
			// Wire a real MockReferrals, set a referrer + non-zero fee, and trigger a losing
			// bet so payReferrer fires its success branch (lines 345-348)
			const Mock = await ethers.getContractFactory('MockReferrals');
			const refContract = await Mock.deploy();
			const refContractAddr = await refContract.getAddress();
			const referrer = ethers.Wallet.createRandom().address;
			// Set a 1% referrer fee (1e16 in 1e18 precision)
			await refContract.setReferrerFees(ethers.parseEther('0.01'), 0n, 0n);
			await refContract.setReferrer(referrer, ctx.player.address);
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					refContractAddr
				);
			const refBalBefore = await ctx.usdc.balanceOf(referrer);
			// Plinko losing bet — payReferrer fires on (payout < amount)
			const tx = await ctx.plinko
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0x0fn]);
			// Referrer got 1% of stake-loss
			const refBalAfter = await ctx.usdc.balanceOf(referrer);
			expect(refBalAfter).to.be.gt(refBalBefore);
		});

		it('payReferrer is no-op when Referrals returns address(0) for the user', async () => {
			// Wire a MockReferrals but DO NOT set a referrer for this user → referrals(user) returns
			// address(0) → hits line 337 (`if (referrer == address(0)) return;`). Trigger via a losing
			// Plinko bet so the on-chain settlement call payReferrer fires naturally.
			const Mock = await ethers.getContractFactory('MockReferrals');
			const refContract = await Mock.deploy();
			const refContractAddr = await refContract.getAddress();
			await refContract.setReferrerFees(ethers.parseEther('0.01'), 0n, 0n);
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					refContractAddr
				);
			const tx = await ctx.plinko
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await expect(ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0x0fn])).to.not
				.be.reverted;
		});

		it('payReferrer is no-op when getReferrerFee returns 0', async () => {
			// Exercises line 377: `if (referrerFee == 0) return`. Set up a valid referrer
			// with referrerFees all zero so getReferrerFee returns 0 → early return without
			// any transfer attempt.
			const Mock = await ethers.getContractFactory('MockReferrals');
			const refContract = await Mock.deploy();
			const refContractAddr = await refContract.getAddress();
			const referrer = ethers.Wallet.createRandom().address;
			await refContract.setReferrer(referrer, ctx.player.address);
			// Fees default to 0 — no setReferrerFees call needed
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					refContractAddr
				);
			const tx = await ctx.plinko
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const refBalBefore = await ctx.usdc.balanceOf(referrer);
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0x0fn]);
			expect(await ctx.usdc.balanceOf(referrer)).to.equal(refBalBefore);
		});

		it('payReferrer skips when referrerAmount rounds to zero', async () => {
			// 1-wei referrer fee. stake * 1 / 1e18 == 0 for sub-1e18 stake-loss → hits line 346
			// (`if (referrerAmount == 0) return;`). Plinko stake-loss is in 6-dec USDC units, so
			// 3 USDC stake-loss = 3e6 * 1 / 1e18 = 0.
			const Mock = await ethers.getContractFactory('MockReferrals');
			const refContract = await Mock.deploy();
			const refContractAddr = await refContract.getAddress();
			const referrer = ethers.Wallet.createRandom().address;
			await refContract.setReferrerFees(1n, 0n, 0n);
			await refContract.setReferrer(referrer, ctx.player.address);
			await ctx.core
				.connect(ctx.owner)
				.setAddresses(
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					ethers.ZeroAddress,
					refContractAddr
				);
			const tx = await ctx.plinko
				.connect(ctx.player)
				.placeBet(ctx.usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const r = await tx.wait();
			const placed = r.logs
				.map((l) => {
					try {
						return ctx.plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const refBalBefore = await ctx.usdc.balanceOf(referrer);
			await ctx.vrf.fulfillRandomWords(ctx.coreAddr, placed.args.requestId, [0x0fn]);
			// referrerAmount rounded to 0 → no transfer
			expect(await ctx.usdc.balanceOf(referrer)).to.equal(refBalBefore);
		});
	});

	describe('View helpers — gameInactiveReason AUTO_PAUSED + getCollateralPrice(usdc)', () => {
		it('gameInactiveReason returns AUTO_PAUSED after circuit-breaker trip', async () => {
			// Trip Plinko's auto-pause by lowering the net-loss threshold and playing a winning bet
			const { core, plinko, plinkoAddr, player, usdcAddr, vrf, coreAddr } = ctx;
			await core.setMaxNetLossPerGameUsd(plinkoAddr, ethers.parseEther('1'));
			// Place a bet and resolve at the highest slot (1000x edge slot 0)
			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, 10n * USDC_UNIT, 0, ethers.ZeroAddress, false);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			// Word 0x00 → slot 0 (top of paytable). Player wins big → tips the circuit breaker.
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [0n]);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.true;
			expect(await core.gameInactiveReason(plinkoAddr)).to.equal(4); // AUTO_PAUSED
		});

		it('getCollateralPrice(usdc) returns 1e18 (the USDC fast-path)', async () => {
			// Exercises line 645: `if (collateral == usdc) return ONE;`
			const price = await ctx.core.getCollateralPrice(ctx.usdcAddr);
			expect(price).to.equal(ethers.parseEther('1'));
		});

		it('getCollateralPrice(weth) returns the price-feed value (non-USDC branch)', async () => {
			// Exercises _getCollateralPrice non-USDC path: 770-777 (key lookup + rateForCurrency)
			const price = await ctx.core.getCollateralPrice(ctx.wethAddr);
			expect(price).to.equal(WETH_PRICE);
		});

		it('getCollateralPrice reverts with InvalidCollateral when WETH key is cleared', async () => {
			// Exercises line 774: `if (currencyKey == bytes32(0)) revert InvalidCollateral`
			await ctx.core.setCollateralConfig(ctx.wethAddr, ethers.ZeroHash, true);
			await expect(ctx.core.getCollateralPrice(ctx.wethAddr)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidCollateral'
			);
		});

		it('getCollateralPrice reverts with InvalidPrice when feed reports 0', async () => {
			// Exercises line 776: `if (price == 0) revert InvalidPrice`
			await ctx.priceFeed.setPriceFeedForCollateral(WETH_KEY, ctx.wethAddr, 0);
			await expect(ctx.core.getCollateralPrice(ctx.wethAddr)).to.be.revertedWithCustomError(
				ctx.core,
				'InvalidPrice'
			);
		});

		it('getUsdValue(weth) returns amount × price / ONE (non-USDC branch)', async () => {
			// Exercises lines 782-783 (_getUsdValue WETH path)
			const amount = ethers.parseEther('2'); // 2 WETH
			const usd = await ctx.core.getUsdValue(ctx.wethAddr, amount);
			expect(usd).to.equal((amount * WETH_PRICE) / ethers.parseEther('1'));
		});

		it('collateralFromUsd(usdc, 0) returns 0 (early return)', async () => {
			// Exercises line 621: `if (usdAmount == 0) return 0`
			expect(await ctx.core.collateralFromUsd(ctx.usdcAddr, 0)).to.equal(0n);
		});

		it('collateralFromUsd(weth, X) returns USD × ONE / price (non-USDC branch)', async () => {
			// Exercises lines 624, 626 (WETH price lookup + division)
			const usdAmount = ethers.parseEther('3000'); // 3000 USD = 1 WETH
			const out = await ctx.core.collateralFromUsd(ctx.wethAddr, usdAmount);
			expect(out).to.equal(ethers.parseEther('1'));
		});

		it('collateralFromUsd reverts with InvalidPrice when WETH price is 0', async () => {
			// Exercises line 625: `if (price == 0) revert InvalidPrice`
			await ctx.priceFeed.setPriceFeedForCollateral(WETH_KEY, ctx.wethAddr, 0);
			await expect(
				ctx.core.collateralFromUsd(ctx.wethAddr, ethers.parseEther('1'))
			).to.be.revertedWithCustomError(ctx.core, 'InvalidPrice');
		});
	});

	describe('Circuit breaker bookkeeping', () => {
		it('houseNetUsd starts at 0, increments correctly on losing bet for player (house gain)', async () => {
			const { core, plinko, plinkoAddr, player, usdcAddr, vrf, coreAddr } = ctx;
			expect(await core.houseNetUsd(plinkoAddr)).to.equal(0n);

			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, MIN_USDC_BET, 0, ethers.ZeroAddress, false);
			const receipt = await tx.wait();
			const placed = receipt.logs
				.map((l) => {
					try {
						return plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			// Word giving slot 4 (middle, low payout 0.5x) → player loses 1.5 USDC net
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [0x0fn]);

			// houseNetUsd should be positive (house gained ~1.5 USDC)
			const net = await core.houseNetUsd(plinkoAddr);
			expect(net).to.be.gt(0n);
		});
	});

	describe('setMaxNetLossPerGameUsd — eager auto-pause on threshold lowering', () => {
		// Drives houseNetUsd[plinko] negative by winning a Plinko HIGH bet (slot 0 = 29x).
		// 10 USDC stake × 29 = 290 USDC payout → ~$280 house loss recorded.
		async function driveHouseNegative() {
			const { plinko, plinkoAddr, player, usdcAddr, vrf, coreAddr, core } = ctx;
			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, 10n * USDC_UNIT, 2, ethers.ZeroAddress, false);
			const placed = (await tx.wait()).logs
				.map((l) => {
					try {
						return plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [0n]);
			return await core.houseNetUsd(plinkoAddr);
		}

		it('auto-pauses immediately when new threshold is below the running loss', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			expect(net).to.be.lt(0n);
			// Default threshold (1000 USD) still covers the ~$280 loss → not paused yet
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.false;

			// Drop the cap to half the current loss → must trip the breaker in the setter itself
			const halfLoss = -net / 2n;
			await expect(core.setMaxNetLossPerGameUsd(plinkoAddr, halfLoss))
				.to.emit(core, 'GameAutoPaused')
				.withArgs(plinkoAddr, net, halfLoss);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.true;
		});

		it('does NOT auto-pause when new threshold still exceeds the running loss', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			const headroomCap = -net + ethers.parseEther('100');
			await expect(core.setMaxNetLossPerGameUsd(plinkoAddr, headroomCap)).to.not.emit(
				core,
				'GameAutoPaused'
			);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.false;
		});

		it('is a no-op when the game is already auto-paused (no double emit)', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			// First call trips the breaker
			await core.setMaxNetLossPerGameUsd(plinkoAddr, -net / 2n);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.true;

			// Lowering further on an already-paused game: no second GameAutoPaused emit
			await expect(core.setMaxNetLossPerGameUsd(plinkoAddr, -net / 4n)).to.not.emit(
				core,
				'GameAutoPaused'
			);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.true;
		});

		it('does NOT auto-pause when houseNetUsd is non-negative regardless of new threshold', async () => {
			const { core, plinkoAddr } = ctx;
			// Gauge starts at 0 (house even). Lowering to 1 wei must not trip the breaker.
			await expect(core.setMaxNetLossPerGameUsd(plinkoAddr, 1n)).to.not.emit(
				core,
				'GameAutoPaused'
			);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.false;
		});
	});

	describe('setDefaultMaxNetLossPerGameUsd — sweep auto-pause when lowered', () => {
		// Same Plinko HIGH-bet trick: drives houseNetUsd[plinko] ≈ -$280
		async function driveHouseNegative() {
			const { plinko, plinkoAddr, player, usdcAddr, vrf, coreAddr, core } = ctx;
			const tx = await plinko
				.connect(player)
				.placeBet(usdcAddr, 10n * USDC_UNIT, 2, ethers.ZeroAddress, false);
			const placed = (await tx.wait()).logs
				.map((l) => {
					try {
						return plinko.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			await vrf.fulfillRandomWords(coreAddr, placed.args.requestId, [0n]);
			return await core.houseNetUsd(plinkoAddr);
		}

		it('sweeps and pauses override-less games when default drops below their loss', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			expect(await core.maxNetLossPerGameUsd(plinkoAddr)).to.equal(0n); // no per-game override
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.false;

			const newDefault = -net / 2n; // half the current loss → must trip
			await expect(core.setDefaultMaxNetLossPerGameUsd(newDefault))
				.to.emit(core, 'GameAutoPaused')
				.withArgs(plinkoAddr, net, newDefault);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.true;
		});

		it('skips the sweep entirely when raising the default', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			// Raise the default well past the current loss — must not emit any GameAutoPaused
			await expect(core.setDefaultMaxNetLossPerGameUsd(ethers.parseEther('10000'))).to.not.emit(
				core,
				'GameAutoPaused'
			);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.false;
			expect(net).to.be.lt(0n); // sanity
		});

		it('does NOT pause games that have their own (looser) override even when default drops', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			const lossAbs = -net;
			// Give Plinko an explicit override well above the loss
			await core.setMaxNetLossPerGameUsd(plinkoAddr, lossAbs + ethers.parseEther('500'));
			// Drop the default below the loss — Plinko has an override so it shouldn't be touched
			await expect(core.setDefaultMaxNetLossPerGameUsd(lossAbs / 2n)).to.not.emit(
				core,
				'GameAutoPaused'
			);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.false;
		});

		it('skips games already auto-paused (no double emit during sweep)', async () => {
			const { core, plinkoAddr } = ctx;
			const net = await driveHouseNegative();
			// Pre-trip via the per-game setter
			await core.setMaxNetLossPerGameUsd(plinkoAddr, -net / 2n);
			expect(await core.gameAutoPaused(plinkoAddr)).to.be.true;
			// Now clear the override so the default applies again
			await core.setMaxNetLossPerGameUsd(plinkoAddr, 0n);
			// Lower the default — Plinko is already paused, so no second GameAutoPaused
			await expect(core.setDefaultMaxNetLossPerGameUsd(-net / 4n)).to.not.emit(
				core,
				'GameAutoPaused'
			);
		});
	});
});
