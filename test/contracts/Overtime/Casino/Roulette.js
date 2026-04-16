const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');
const { ZERO_ADDRESS } = require('../../../constants/general');

// Mirrors Roulette.sol BetType enum
const BetType = { STRAIGHT: 0, RED_BLACK: 1, ODD_EVEN: 2, LOW_HIGH: 3, DOZEN: 4, COLUMN: 5 };

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000'); // 3000 USD per WETH
const OVER_PRICE = ethers.parseEther('1'); // 1 USD per OVER

const MAX_PROFIT_USD = ethers.parseEther('1000'); // 1000 USD
const CANCEL_TIMEOUT = 3600n; // 1 hour in seconds

// Minimum bets that satisfy MIN_BET_USD (3 USD)
const MIN_USDC_BET = 3n * 1_000_000n; // 3 USDC (6 dec)
const MIN_WETH_BET = ethers.parseEther('0.001'); // 0.001 WETH = 3 USD at 3000 USD/WETH

async function deployRouletteFixture() {
	const [owner, secondAccount, resolver, riskManager, pauser, player] = await ethers.getSigners();

	// Tokens
	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();

	const usdcAddress = await usdc.getAddress();
	const wethAddress = await weth.getAddress();
	const overAddress = await over.getAddress();

	// Price feed
	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddress, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddress, OVER_PRICE);
	const priceFeedAddress = await priceFeed.getAddress();

	// Manager
	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(SportsAMMV2Manager, [owner.address]);
	const managerAddress = await manager.getAddress();

	// Whitelist roles — RISK_MANAGING=1, MARKET_RESOLVING=2, TICKET_PAUSER=3
	await manager.setWhitelistedAddresses([resolver.address], 2, true);
	await manager.setWhitelistedAddresses([riskManager.address], 1, true);
	await manager.setWhitelistedAddresses([pauser.address], 3, true);

	// VRF coordinator mock
	const MockVRFCoordinator = await ethers.getContractFactory('MockVRFCoordinator');
	const vrfCoordinator = await MockVRFCoordinator.deploy();
	const vrfCoordinatorAddress = await vrfCoordinator.getAddress();

	// Roulette
	const RouletteFactory = await ethers.getContractFactory('Roulette');
	const roulette = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
	const rouletteAddress = await roulette.getAddress();

	await roulette.initialize(
		{
			owner: owner.address,
			manager: managerAddress,
			priceFeed: priceFeedAddress,
			vrfCoordinator: vrfCoordinatorAddress,
		},
		{
			usdc: usdcAddress,
			weth: wethAddress,
			over: overAddress,
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 200000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);

	// Fund roulette bankroll
	await usdc.transfer(rouletteAddress, 50n * 1_000_000n); // 50 USDC
	await weth.transfer(rouletteAddress, ethers.parseEther('10')); // 10 WETH
	await over.transfer(rouletteAddress, ethers.parseEther('50')); // 50 OVER

	// Fund player
	await usdc.transfer(player.address, 40n * 1_000_000n); // 40 USDC
	await weth.transfer(player.address, ethers.parseEther('10')); // 10 WETH
	await over.transfer(player.address, ethers.parseEther('20')); // 20 OVER

	return {
		roulette,
		rouletteAddress,
		usdc,
		usdcAddress,
		weth,
		wethAddress,
		over,
		overAddress,
		priceFeed,
		manager,
		managerAddress,
		vrfCoordinator,
		vrfCoordinatorAddress,
		owner,
		secondAccount,
		resolver,
		riskManager,
		pauser,
		player,
	};
}

// Parse the BetPlaced event from a transaction receipt
async function parseBetPlaced(roulette, tx) {
	const receipt = await tx.wait();
	const parsed = receipt.logs
		.map((log) => {
			try {
				return roulette.interface.parseLog(log);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	return { betId: parsed.args.betId, requestId: parsed.args.requestId };
}

describe('Roulette', () => {
	let roulette,
		rouletteAddress,
		usdc,
		usdcAddress,
		weth,
		wethAddress,
		over,
		overAddress,
		vrfCoordinator,
		manager,
		owner,
		secondAccount,
		resolver,
		riskManager,
		pauser,
		player;

	beforeEach(async () => {
		({
			roulette,
			rouletteAddress,
			usdc,
			usdcAddress,
			weth,
			wethAddress,
			over,
			overAddress,
			vrfCoordinator,
			manager,
			owner,
			secondAccount,
			resolver,
			riskManager,
			pauser,
			player,
		} = await loadFixture(deployRouletteFixture));
	});

	/* ========== INITIALIZATION ========== */

	describe('Initialization', () => {
		it('should set correct state after initialize', async () => {
			expect(await roulette.owner()).to.equal(owner.address);
			expect(await roulette.usdc()).to.equal(usdcAddress);
			expect(await roulette.weth()).to.equal(wethAddress);
			expect(await roulette.over()).to.equal(overAddress);
			expect(await roulette.maxProfitUsd()).to.equal(MAX_PROFIT_USD);
			expect(await roulette.cancelTimeout()).to.equal(CANCEL_TIMEOUT);
			expect(await roulette.nextBetId()).to.equal(1n);
			expect(await roulette.subscriptionId()).to.equal(1n);
			expect(await roulette.callbackGasLimit()).to.equal(200000n);
			expect(await roulette.requestConfirmations()).to.equal(3n);
			expect(await roulette.nativePayment()).to.equal(false);
			expect(await roulette.supportedCollateral(usdcAddress)).to.equal(true);
			expect(await roulette.supportedCollateral(wethAddress)).to.equal(true);
			expect(await roulette.supportedCollateral(overAddress)).to.equal(true);
		});

		it('should revert on re-initialization', async () => {
			await expect(
				roulette.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: wethAddress,
						over: overAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 200000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.reverted;
		});

		it('should revert if owner address is zero', async () => {
			const RouletteFactory = await ethers.getContractFactory('Roulette');
			const fresh = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
			await expect(
				fresh.initialize(
					{
						owner: ZERO_ADDRESS,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: wethAddress,
						over: overAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 200000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(fresh, 'InvalidAddress');
		});

		it('should revert with zero collateral address (usdc)', async () => {
			const RouletteFactory = await ethers.getContractFactory('Roulette');
			const fresh = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
			await expect(
				fresh.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: ZERO_ADDRESS,
						weth: wethAddress,
						over: overAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 200000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(fresh, 'InvalidAddress');
		});

		it('should revert if maxProfitUsd is zero', async () => {
			const RouletteFactory = await ethers.getContractFactory('Roulette');
			const fresh = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
			await expect(
				fresh.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: wethAddress,
						over: overAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					0,
					CANCEL_TIMEOUT,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 200000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(fresh, 'InvalidAmount');
		});

		it('should revert if callbackGasLimit is zero', async () => {
			const RouletteFactory = await ethers.getContractFactory('Roulette');
			const fresh = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
			await expect(
				fresh.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: wethAddress,
						over: overAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 0,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(fresh, 'InvalidAmount');
		});
	});

	/* ========== PLACE BET ========== */

	describe('placeBet', () => {
		it('should revert for unsupported collateral', async () => {
			await expect(
				roulette
					.connect(player)
					.placeBet(secondAccount.address, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(
				roulette.connect(player).placeBet(usdcAddress, 0, BetType.RED_BLACK, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidAmount');
		});

		it('should revert when amount is below MIN_BET_USD', async () => {
			// 1 USDC = 1 USD < MIN_BET_USD (3 USD)
			await usdc.connect(player).approve(rouletteAddress, 1_000_000n);
			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, 1_000_000n, BetType.RED_BLACK, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidAmount');
		});

		it('should revert for invalid selection on RED_BLACK (selection > 1)', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 2, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidSelection');
		});

		it('should revert for invalid selection on STRAIGHT (selection > 36)', async () => {
			await weth.connect(player).approve(rouletteAddress, MIN_WETH_BET);
			await expect(
				roulette
					.connect(player)
					.placeBet(wethAddress, MIN_WETH_BET, BetType.STRAIGHT, 37, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidSelection');
		});

		it('should revert when MaxProfitExceeded', async () => {
			// WETH straight (35x): bet 0.01 WETH → profit = 0.35 WETH = 1050 USD > 1000 USD maxProfitUsd
			const largeBet = ethers.parseEther('0.01');
			await weth.connect(player).approve(rouletteAddress, largeBet);
			await expect(
				roulette
					.connect(player)
					.placeBet(wethAddress, largeBet, BetType.STRAIGHT, 7, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'MaxProfitExceeded');
		});

		it('should revert when InsufficientAvailableLiquidity', async () => {
			// USDC bankroll is 50 USDC. Straight bet (35x) on 3 USDC needs 105 USDC profit — exceeds bankroll.
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InsufficientAvailableLiquidity');
		});

		it('should revert when paused', async () => {
			await roulette.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress)
			).to.be.reverted;
		});

		it('should place a USDC RED_BLACK bet successfully', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const playerBalanceBefore = await usdc.balanceOf(player.address);
			const rouletteBalanceBefore = await usdc.balanceOf(rouletteAddress);

			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress)
			)
				.to.emit(roulette, 'BetPlaced')
				.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0);

			// Funds transferred
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalanceBefore - MIN_USDC_BET);
			expect(await usdc.balanceOf(rouletteAddress)).to.equal(rouletteBalanceBefore + MIN_USDC_BET);

			// Reservation set (1x multiplier for RED_BLACK)
			expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(MIN_USDC_BET);

			// Bet stored
			const betBase = await roulette.getBetBase(1n);
			const betDetails = await roulette.getBetDetails(1n);
			expect(betBase.user).to.equal(player.address);
			expect(betBase.collateral).to.equal(usdcAddress);
			expect(betBase.amount).to.equal(MIN_USDC_BET);
			expect(betDetails.status).to.equal(1n); // PENDING
			expect(betDetails.betPicks.length).to.equal(1);
			expect(betDetails.betPicks[0].betType).to.equal(BigInt(BetType.RED_BLACK));
			expect(betDetails.betPicks[0].selection).to.equal(0n);

			// nextBetId incremented
			expect(await roulette.nextBetId()).to.equal(2n);
		});

		it('should place a WETH STRAIGHT bet successfully', async () => {
			await weth.connect(player).approve(rouletteAddress, MIN_WETH_BET);

			const tx = await roulette
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			expect(betId).to.equal(1n);
			expect(requestId).to.equal(1n);

			// Reservation = 35x bet
			expect(await roulette.reservedProfitPerCollateral(wethAddress)).to.equal(MIN_WETH_BET * 35n);

			// requestId mapped to betId
			expect(await roulette.requestIdToBetId(requestId)).to.equal(betId);
		});

		it('should place a DOZEN bet successfully', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.DOZEN, 0, ethers.ZeroAddress);
			const betDetails = await roulette.getBetDetails(1n);
			expect(betDetails.status).to.equal(1n); // PENDING
			expect(betDetails.betPicks[0].betType).to.equal(BigInt(BetType.DOZEN));
		});

		it('should place a COLUMN bet successfully', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.COLUMN, 0, ethers.ZeroAddress);
			const betDetails = await roulette.getBetDetails(1n);
			expect(betDetails.status).to.equal(1n); // PENDING
			expect(betDetails.betPicks[0].betType).to.equal(BigInt(BetType.COLUMN));
		});

		it('should revert DOZEN with invalid selection (>= 3)', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.DOZEN, 3, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidSelection');
		});

		it('should revert COLUMN with invalid selection (>= 3)', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await expect(
				roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.COLUMN, 3, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(roulette, 'InvalidSelection');
		});

		it('should increment betId per bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 3n);

			const tx1 = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const tx2 = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 1, ethers.ZeroAddress);
			const tx3 = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ODD_EVEN, 0, ethers.ZeroAddress);

			const { betId: id1 } = await parseBetPlaced(roulette, tx1);
			const { betId: id2 } = await parseBetPlaced(roulette, tx2);
			const { betId: id3 } = await parseBetPlaced(roulette, tx3);

			expect(id1).to.equal(1n);
			expect(id2).to.equal(2n);
			expect(id3).to.equal(3n);
		});
	});

	/* ========== VRF FULFILLMENT ========== */

	describe('VRF fulfillment', () => {
		it('should resolve a winning WETH STRAIGHT bet and send payout', async () => {
			await weth.connect(player).approve(rouletteAddress, MIN_WETH_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			const playerBalanceBefore = await weth.balanceOf(player.address);
			const expectedPayout = MIN_WETH_BET + MIN_WETH_BET * 35n; // stake + profit

			// randomWords[0] % 38 == 7 → wins
			await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [7n]))
				.to.emit(roulette, 'BetResolved')
				.withArgs(betId, requestId, player.address, 7, true, expectedPayout);

			// Payout sent to player
			expect(await weth.balanceOf(player.address)).to.equal(playerBalanceBefore + expectedPayout);

			// Bet state updated
			const betDetails = await roulette.getBetDetails(betId);
			const betBase = await roulette.getBetBase(betId);
			expect(betDetails.won).to.equal(true);
			expect(betBase.payout).to.equal(expectedPayout);
			expect(betDetails.status).to.equal(2n); // RESOLVED
			expect(betDetails.result).to.equal(7n);

			// Reservation released
			expect(await roulette.reservedProfitPerCollateral(wethAddress)).to.equal(0n);
		});

		it('should resolve a losing WETH STRAIGHT bet with no payout', async () => {
			await weth.connect(player).approve(rouletteAddress, MIN_WETH_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			const playerBalanceBefore = await weth.balanceOf(player.address);

			// randomWords[0] % 38 == 8 → loses (selected 7)
			await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [8n]))
				.to.emit(roulette, 'BetResolved')
				.withArgs(betId, requestId, player.address, 8, false, 0n);

			// No payout
			expect(await weth.balanceOf(player.address)).to.equal(playerBalanceBefore);

			const betDetails = await roulette.getBetDetails(betId);
			const betBase = await roulette.getBetBase(betId);
			expect(betDetails.won).to.equal(false);
			expect(betBase.payout).to.equal(0n);
			expect(betDetails.status).to.equal(2n); // RESOLVED
		});

		it('should resolve a winning DOZEN bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.DOZEN, 0, ethers.ZeroAddress); // first dozen (1-12)
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			// randomWord % 38 == 5 -> result=5, in first dozen -> win. Payout = stake + 2x profit
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [5n]);

			const betDetails = await roulette.getBetDetails(betId);
			expect(betDetails.won).to.equal(true);
			expect(betDetails.status).to.equal(2n); // RESOLVED
		});

		it('should resolve a losing DOZEN bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.DOZEN, 0, ethers.ZeroAddress); // first dozen (1-12)
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			// randomWord % 38 == 13 -> result=13, in second dozen -> loss for selection 0
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [13n]);

			const betDetails = await roulette.getBetDetails(betId);
			expect(betDetails.won).to.equal(false);
		});

		it('should resolve a winning COLUMN bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.COLUMN, 0, ethers.ZeroAddress); // column 0 (1,4,7,10,...)
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			// randomWord % 38 == 1 -> result=1, (1-1)%3=0 -> column 0 -> win
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

			const betDetails = await roulette.getBetDetails(betId);
			expect(betDetails.won).to.equal(true);
			expect(betDetails.status).to.equal(2n); // RESOLVED
		});

		it('should resolve a losing COLUMN bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.COLUMN, 0, ethers.ZeroAddress); // column 0 (1,4,7,10,...)
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			// randomWord % 38 == 2 -> result=2, (2-1)%3=1 -> column 1 -> loss for selection 0
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [2n]);

			const betDetails = await roulette.getBetDetails(betId);
			expect(betDetails.won).to.equal(false);
		});

		it('should silently skip an unknown requestId', async () => {
			// No bet was placed; requestId 999 is unknown
			await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, 999n, [7n])).to.not.be
				.reverted;
		});

		it('should silently skip an already-resolved bet', async () => {
			await weth.connect(player).approve(rouletteAddress, MIN_WETH_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			// First fulfillment resolves the bet
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [8n]);
			expect((await roulette.getBetDetails(betId)).status).to.equal(2n); // RESOLVED

			// Second fulfillment is a no-op (no revert, no double-payout)
			await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [7n])).to.not.be
				.reverted;
			expect((await roulette.getBetDetails(betId)).won).to.equal(false); // unchanged
		});

		it('should revert if rawFulfillRandomWords is called by non-coordinator', async () => {
			await expect(
				roulette.connect(secondAccount).rawFulfillRandomWords(1n, [7n])
			).to.be.revertedWithCustomError(roulette, 'InvalidSender');
		});
	});

	/* ========== CANCEL BET ========== */

	describe('cancelBet', () => {
		it('should revert if bet not found', async () => {
			await expect(roulette.connect(player).cancelBet(999n)).to.be.revertedWithCustomError(
				roulette,
				'BetNotFound'
			);
		});

		it('should revert if caller is not the bet owner', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(roulette, tx);

			await expect(roulette.connect(secondAccount).cancelBet(betId)).to.be.revertedWithCustomError(
				roulette,
				'BetNotOwner'
			);
		});

		it('should revert if cancel timeout not reached', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(roulette, tx);

			await expect(roulette.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				roulette,
				'CancelTimeoutNotReached'
			);
		});

		it('should successfully cancel after timeout and refund player', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			const playerBalanceBefore = await usdc.balanceOf(player.address);
			const reservedBefore = await roulette.reservedProfitPerCollateral(usdcAddress);

			await time.increase(CANCEL_TIMEOUT);

			await expect(roulette.connect(player).cancelBet(betId))
				.to.emit(roulette, 'BetCancelled')
				.withArgs(betId, requestId, player.address, MIN_USDC_BET, false);

			// Refunded
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalanceBefore + MIN_USDC_BET);

			// Reservation released
			expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(
				reservedBefore - MIN_USDC_BET
			);

			// Bet status updated
			const betDetails = await roulette.getBetDetails(betId);
			const betBase = await roulette.getBetBase(betId);
			expect(betDetails.status).to.equal(3n); // CANCELLED
			expect(betBase.payout).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== ADMIN CANCEL BET ========== */

	describe('adminCancelBet', () => {
		it('should revert for non-resolver', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(roulette, tx);

			await expect(
				roulette.connect(secondAccount).adminCancelBet(betId)
			).to.be.revertedWithCustomError(roulette, 'InvalidSender');
		});

		it('should allow owner to adminCancel immediately without timeout', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			await expect(roulette.connect(owner).adminCancelBet(betId))
				.to.emit(roulette, 'BetCancelled')
				.withArgs(betId, requestId, player.address, MIN_USDC_BET, true);
		});

		it('should allow whitelisted resolver to adminCancel', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(roulette, tx);

			await expect(roulette.connect(resolver).adminCancelBet(betId)).to.emit(
				roulette,
				'BetCancelled'
			);
		});

		it('should revert adminCancel on already-resolved bet', async () => {
			await weth.connect(player).approve(rouletteAddress, MIN_WETH_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [8n]);

			await expect(roulette.connect(owner).adminCancelBet(betId)).to.be.revertedWithCustomError(
				roulette,
				'BetNotPending'
			);
		});
	});

	/* ========== WITHDRAW COLLATERAL ========== */

	describe('withdrawCollateral', () => {
		it('should allow owner to withdraw to a specified recipient', async () => {
			const amount = ethers.parseEther('1');
			const recipientBefore = await weth.balanceOf(secondAccount.address);

			await expect(
				roulette.connect(owner).withdrawCollateral(wethAddress, secondAccount.address, amount)
			)
				.to.emit(roulette, 'WithdrawnCollateral')
				.withArgs(wethAddress, secondAccount.address, amount);

			expect(await weth.balanceOf(secondAccount.address)).to.equal(recipientBefore + amount);
		});

		it('should withdraw to owner when recipient is zero address', async () => {
			const amount = ethers.parseEther('1');
			const ownerBefore = await weth.balanceOf(owner.address);

			await expect(roulette.connect(owner).withdrawCollateral(wethAddress, ZERO_ADDRESS, amount))
				.to.emit(roulette, 'WithdrawnCollateral')
				.withArgs(wethAddress, owner.address, amount);

			expect(await weth.balanceOf(owner.address)).to.equal(ownerBefore + amount);
		});

		it('should revert for non-owner', async () => {
			await expect(
				roulette.connect(secondAccount).withdrawCollateral(wethAddress, secondAccount.address, 1n)
			).to.be.reverted;
		});
	});

	/* ========== PAUSE ========== */

	describe('setPausedByRole', () => {
		it('should revert for non-pauser', async () => {
			await expect(
				roulette.connect(secondAccount).setPausedByRole(true)
			).to.be.revertedWithCustomError(roulette, 'InvalidSender');
		});

		it('should pause and emit PauseChanged', async () => {
			await expect(roulette.connect(pauser).setPausedByRole(true))
				.to.emit(roulette, 'PauseChanged')
				.withArgs(true);
			expect(await roulette.paused()).to.equal(true);
		});

		it('should unpause and emit PauseChanged', async () => {
			await roulette.connect(pauser).setPausedByRole(true);
			await expect(roulette.connect(pauser).setPausedByRole(false))
				.to.emit(roulette, 'PauseChanged')
				.withArgs(false);
			expect(await roulette.paused()).to.equal(false);
		});

		it('should not emit if pause state is unchanged', async () => {
			await expect(roulette.connect(pauser).setPausedByRole(false)).to.not.emit(
				roulette,
				'PauseChanged'
			);
		});

		it('should allow owner to pause', async () => {
			await expect(roulette.connect(owner).setPausedByRole(true)).to.emit(roulette, 'PauseChanged');
		});
	});

	/* ========== SETTERS ========== */

	describe('Setters', () => {
		describe('setMaxProfitUsd', () => {
			it('should revert for non-risk-manager', async () => {
				await expect(
					roulette.connect(secondAccount).setMaxProfitUsd(ethers.parseEther('500'))
				).to.be.revertedWithCustomError(roulette, 'InvalidSender');
			});

			it('should revert when value is zero', async () => {
				await expect(roulette.connect(owner).setMaxProfitUsd(0)).to.be.revertedWithCustomError(
					roulette,
					'InvalidAmount'
				);
			});

			it('should update maxProfitUsd and emit event', async () => {
				const newValue = ethers.parseEther('500');
				await expect(roulette.connect(riskManager).setMaxProfitUsd(newValue))
					.to.emit(roulette, 'MaxProfitUsdChanged')
					.withArgs(newValue);
				expect(await roulette.maxProfitUsd()).to.equal(newValue);
			});
		});

		describe('setCancelTimeout', () => {
			it('should revert for non-risk-manager', async () => {
				await expect(
					roulette.connect(secondAccount).setCancelTimeout(7200n)
				).to.be.revertedWithCustomError(roulette, 'InvalidSender');
			});

			it('should update cancelTimeout and emit event', async () => {
				await expect(roulette.connect(riskManager).setCancelTimeout(7200n))
					.to.emit(roulette, 'CancelTimeoutChanged')
					.withArgs(7200n);
				expect(await roulette.cancelTimeout()).to.equal(7200n);
			});
		});

		describe('setSupportedCollateral', () => {
			it('should revert for non-risk-manager', async () => {
				await expect(
					roulette.connect(secondAccount).setSupportedCollateral(usdcAddress, false)
				).to.be.revertedWithCustomError(roulette, 'InvalidSender');
			});

			it('should revert for zero address', async () => {
				await expect(
					roulette.connect(owner).setSupportedCollateral(ZERO_ADDRESS, true)
				).to.be.revertedWithCustomError(roulette, 'InvalidAddress');
			});

			it('should update collateral support and emit event', async () => {
				await expect(roulette.connect(riskManager).setSupportedCollateral(usdcAddress, false))
					.to.emit(roulette, 'SupportedCollateralChanged')
					.withArgs(usdcAddress, false);
				expect(await roulette.supportedCollateral(usdcAddress)).to.equal(false);
			});
		});

		describe('setManager', () => {
			it('should revert for non-owner', async () => {
				await expect(roulette.connect(secondAccount).setManager(owner.address)).to.be.reverted;
			});

			it('should revert for zero address', async () => {
				await expect(
					roulette.connect(owner).setManager(ZERO_ADDRESS)
				).to.be.revertedWithCustomError(roulette, 'InvalidAddress');
			});

			it('should update manager and emit event', async () => {
				await expect(roulette.connect(owner).setManager(owner.address))
					.to.emit(roulette, 'ManagerChanged')
					.withArgs(owner.address);
			});
		});

		describe('setVrfConfig', () => {
			it('should revert for non-owner', async () => {
				await expect(
					roulette.connect(secondAccount).setVrfConfig(1n, ethers.ZeroHash, 200000n, 3n, false)
				).to.be.reverted;
			});

			it('should revert when callbackGasLimit is zero', async () => {
				await expect(
					roulette.connect(owner).setVrfConfig(1n, ethers.ZeroHash, 0n, 3n, false)
				).to.be.revertedWithCustomError(roulette, 'InvalidAmount');
			});

			it('should accept zero requestConfirmations', async () => {
				await expect(
					roulette.connect(owner).setVrfConfig(1n, ethers.ZeroHash, 200000n, 0n, false)
				).to.emit(roulette, 'VrfConfigChanged');
			});

			it('should update VRF config and emit event', async () => {
				await expect(roulette.connect(owner).setVrfConfig(2n, ethers.ZeroHash, 300000n, 5n, true))
					.to.emit(roulette, 'VrfConfigChanged')
					.withArgs(2n, ethers.ZeroHash, 300000n, 5n, true);
				expect(await roulette.subscriptionId()).to.equal(2n);
				expect(await roulette.callbackGasLimit()).to.equal(300000n);
				expect(await roulette.nativePayment()).to.equal(true);
			});
		});

		describe('setPriceFeed', () => {
			it('should revert for zero address', async () => {
				await expect(
					roulette.connect(owner).setPriceFeed(ZERO_ADDRESS)
				).to.be.revertedWithCustomError(roulette, 'InvalidAddress');
			});

			it('should update priceFeed and emit event', async () => {
				await expect(roulette.connect(owner).setPriceFeed(secondAccount.address))
					.to.emit(roulette, 'PriceFeedChanged')
					.withArgs(secondAccount.address);
			});
		});

		describe('setVrfCoordinator', () => {
			it('should revert for zero address', async () => {
				await expect(
					roulette.connect(owner).setVrfCoordinator(ZERO_ADDRESS)
				).to.be.revertedWithCustomError(roulette, 'InvalidAddress');
			});

			it('should update vrfCoordinator and emit event', async () => {
				await expect(roulette.connect(owner).setVrfCoordinator(secondAccount.address))
					.to.emit(roulette, 'VrfCoordinatorChanged')
					.withArgs(secondAccount.address);
			});
		});

		describe('setPriceFeedKeyPerCollateral', () => {
			it('should revert for zero address', async () => {
				await expect(
					roulette.connect(owner).setPriceFeedKeyPerCollateral(ZERO_ADDRESS, WETH_KEY)
				).to.be.revertedWithCustomError(roulette, 'InvalidAddress');
			});

			it('should update key and emit event', async () => {
				const testKey = ethers.encodeBytes32String('TEST');
				await expect(
					roulette.connect(owner).setPriceFeedKeyPerCollateral(secondAccount.address, testKey)
				)
					.to.emit(roulette, 'PriceFeedKeyPerCollateralChanged')
					.withArgs(secondAccount.address, testKey);
			});
		});

		describe('insufficient liquidity rollback', () => {
			it('placeBet should revert and rollback reservedProfit on insufficient liquidity', async () => {
				const balance = await usdc.balanceOf(rouletteAddress);
				await roulette.connect(owner).withdrawCollateral(usdcAddress, owner.address, balance);

				const reservedBefore = await roulette.reservedProfitPerCollateral(usdcAddress);

				// STRAIGHT bet: 35x payout, reserved = 34*3 = 102 USDC > 3 USDC bet amount
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
				await expect(
					roulette
						.connect(player)
						.placeBet(usdcAddress, MIN_USDC_BET, BetType.STRAIGHT, 7, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InsufficientAvailableLiquidity');

				const reservedAfter = await roulette.reservedProfitPerCollateral(usdcAddress);
				expect(reservedAfter).to.equal(reservedBefore);
			});
		});
	});

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		describe('getCollateralPrice', () => {
			it('should return ONE for USDC', async () => {
				expect(await roulette.getCollateralPrice(usdcAddress)).to.equal(ethers.parseEther('1'));
			});

			it('should return the price feed value for WETH', async () => {
				expect(await roulette.getCollateralPrice(wethAddress)).to.equal(WETH_PRICE);
			});

			it('should revert for unsupported collateral', async () => {
				await expect(
					roulette.getCollateralPrice(secondAccount.address)
				).to.be.revertedWithCustomError(roulette, 'InvalidCollateral');
			});
		});

		describe('getPotentialProfit', () => {
			it('should return correct USD profit for RED_BLACK (1x)', async () => {
				// 3 USDC * 1 = 3 USDC = 3 USD
				expect(
					await roulette.getPotentialProfit(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK)
				).to.equal(ethers.parseEther('3'));
			});

			it('should return correct USD profit for STRAIGHT (35x)', async () => {
				// 0.001 WETH * 35 * 3000 = 105 USD
				expect(
					await roulette.getPotentialProfit(wethAddress, MIN_WETH_BET, BetType.STRAIGHT)
				).to.equal(ethers.parseEther('105'));
			});
		});

		describe('getPotentialPayoutCollateral', () => {
			it('should return stake + profit for RED_BLACK', async () => {
				// 3 USDC + 3 USDC = 6 USDC
				expect(
					await roulette.getPotentialPayoutCollateral(MIN_USDC_BET, BetType.RED_BLACK)
				).to.equal(MIN_USDC_BET * 2n);
			});

			it('should return stake + profit for STRAIGHT', async () => {
				// 0.001 WETH + 0.035 WETH = 0.036 WETH
				expect(
					await roulette.getPotentialPayoutCollateral(MIN_WETH_BET, BetType.STRAIGHT)
				).to.equal(MIN_WETH_BET * 36n);
			});
		});

		describe('isWinningBet', () => {
			// STRAIGHT
			it('STRAIGHT: wins on exact number', async () => {
				expect(await roulette.isWinningBet(BetType.STRAIGHT, 7, 7)).to.equal(true);
			});
			it('STRAIGHT: loses on different number', async () => {
				expect(await roulette.isWinningBet(BetType.STRAIGHT, 7, 8)).to.equal(false);
			});
			// RED_BLACK
			it('RED_BLACK: 0 always loses', async () => {
				expect(await roulette.isWinningBet(BetType.RED_BLACK, 0, 0)).to.equal(false);
			});
			it('RED_BLACK: selection 0 wins on red number (1)', async () => {
				expect(await roulette.isWinningBet(BetType.RED_BLACK, 0, 1)).to.equal(true);
			});
			it('RED_BLACK: selection 1 wins on black number (2)', async () => {
				expect(await roulette.isWinningBet(BetType.RED_BLACK, 1, 2)).to.equal(true);
			});
			it('RED_BLACK: selection 0 loses on black number (2)', async () => {
				expect(await roulette.isWinningBet(BetType.RED_BLACK, 0, 2)).to.equal(false);
			});

			// ODD_EVEN
			it('ODD_EVEN: selection 0 wins on odd (1)', async () => {
				expect(await roulette.isWinningBet(BetType.ODD_EVEN, 0, 1)).to.equal(true);
			});
			it('ODD_EVEN: selection 1 wins on even (2)', async () => {
				expect(await roulette.isWinningBet(BetType.ODD_EVEN, 1, 2)).to.equal(true);
			});
			it('ODD_EVEN: 0 always loses', async () => {
				expect(await roulette.isWinningBet(BetType.ODD_EVEN, 1, 0)).to.equal(false);
			});

			// LOW_HIGH
			it('LOW_HIGH: selection 0 wins on 1', async () => {
				expect(await roulette.isWinningBet(BetType.LOW_HIGH, 0, 1)).to.equal(true);
			});
			it('LOW_HIGH: selection 0 wins on 18', async () => {
				expect(await roulette.isWinningBet(BetType.LOW_HIGH, 0, 18)).to.equal(true);
			});
			it('LOW_HIGH: selection 1 wins on 19', async () => {
				expect(await roulette.isWinningBet(BetType.LOW_HIGH, 1, 19)).to.equal(true);
			});
			it('LOW_HIGH: selection 1 wins on 36', async () => {
				expect(await roulette.isWinningBet(BetType.LOW_HIGH, 1, 36)).to.equal(true);
			});
			it('LOW_HIGH: selection 0 loses on 19', async () => {
				expect(await roulette.isWinningBet(BetType.LOW_HIGH, 0, 19)).to.equal(false);
			});

			// DOZEN
			it('DOZEN: selection 0 wins on 1', async () => {
				expect(await roulette.isWinningBet(BetType.DOZEN, 0, 1)).to.equal(true);
			});
			it('DOZEN: selection 0 wins on 12', async () => {
				expect(await roulette.isWinningBet(BetType.DOZEN, 0, 12)).to.equal(true);
			});
			it('DOZEN: selection 1 wins on 13', async () => {
				expect(await roulette.isWinningBet(BetType.DOZEN, 1, 13)).to.equal(true);
			});
			it('DOZEN: selection 2 wins on 36', async () => {
				expect(await roulette.isWinningBet(BetType.DOZEN, 2, 36)).to.equal(true);
			});
			it('DOZEN: selection 0 loses on 13', async () => {
				expect(await roulette.isWinningBet(BetType.DOZEN, 0, 13)).to.equal(false);
			});

			// COLUMN — column = (n - 1) % 3
			it('COLUMN: selection 0 wins on 1 (column 0)', async () => {
				expect(await roulette.isWinningBet(BetType.COLUMN, 0, 1)).to.equal(true);
			});
			it('COLUMN: selection 1 wins on 2 (column 1)', async () => {
				expect(await roulette.isWinningBet(BetType.COLUMN, 1, 2)).to.equal(true);
			});
			it('COLUMN: selection 2 wins on 3 (column 2)', async () => {
				expect(await roulette.isWinningBet(BetType.COLUMN, 2, 3)).to.equal(true);
			});
			it('COLUMN: selection 0 loses on 2', async () => {
				expect(await roulette.isWinningBet(BetType.COLUMN, 0, 2)).to.equal(false);
			});
		});

		describe('getAvailableLiquidity', () => {
			it('should return full bankroll when no bets are pending', async () => {
				expect(await roulette.getAvailableLiquidity(usdcAddress)).to.equal(50n * 1_000_000n);
				expect(await roulette.getAvailableLiquidity(wethAddress)).to.equal(ethers.parseEther('10'));
			});

			it('should deduct reserved profit from available liquidity', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
				await roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);

				// Reservation = MIN_USDC_BET (1x), balance grew by MIN_USDC_BET
				// Available = (50e6 + MIN_USDC_BET) - MIN_USDC_BET = 50e6
				expect(await roulette.getAvailableLiquidity(usdcAddress)).to.equal(50n * 1_000_000n);
			});

			it('should revert for unsupported collateral', async () => {
				await expect(
					roulette.getAvailableLiquidity(secondAccount.address)
				).to.be.revertedWithCustomError(roulette, 'InvalidCollateral');
			});
		});
	});

	/* ========== SPLIT GETTERS ========== */

	describe('Split Getters', () => {
		it('getBetBase returns correct values after placing a bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(roulette, tx);

			const betBase = await roulette.getBetBase(betId);
			expect(betBase.user).to.equal(player.address);
			expect(betBase.collateral).to.equal(usdcAddress);
			expect(betBase.amount).to.equal(MIN_USDC_BET);
			expect(betBase.payout).to.equal(0n);
			expect(betBase.reservedProfit).to.equal(MIN_USDC_BET); // RED_BLACK 1x
		});

		it('getBetDetails returns correct values after resolution', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			// 1 is red, so selection=0 (red) wins
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

			const betDetails = await roulette.getBetDetails(betId);
			expect(betDetails.status).to.equal(2n); // RESOLVED
			expect(betDetails.betPicks[0].betType).to.equal(BigInt(BetType.RED_BLACK));
			expect(betDetails.betPicks[0].selection).to.equal(0n);
			expect(betDetails.result).to.equal(1n);
			expect(betDetails.won).to.equal(true);
		});
	});

	/* ========== AUDIT FIXES ========== */

	describe('Audit Fixes', () => {
		it('withdrawCollateral should revert when amount exceeds available (reserved funds protection)', async () => {
			// Place a bet to create reserved profit
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);

			// Try to withdraw all balance - should fail because some is reserved
			const balance = await usdc.balanceOf(rouletteAddress);
			await expect(
				roulette.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, balance)
			).to.be.revertedWithCustomError(roulette, 'InsufficientAvailableLiquidity');
		});

		it('setCancelTimeout should revert below MIN_CANCEL_TIMEOUT (30)', async () => {
			await expect(roulette.connect(owner).setCancelTimeout(29)).to.be.revertedWithCustomError(
				roulette,
				'InvalidAmount'
			);
		});

		it('setCancelTimeout should succeed at MIN_CANCEL_TIMEOUT', async () => {
			await expect(roulette.connect(owner).setCancelTimeout(30))
				.to.emit(roulette, 'CancelTimeoutChanged')
				.withArgs(30);
		});
	});

	/* ========== FREE BET PATHS ========== */

	describe('FreeBet Paths', () => {
		it('placeBetWithFreeBet should revert for unsupported collateral', async () => {
			await expect(
				roulette
					.connect(player)
					.placeBetWithFreeBet(secondAccount.address, MIN_USDC_BET, BetType.RED_BLACK, 0)
			).to.be.revertedWithCustomError(roulette, 'InvalidCollateral');
		});

		it('placeBetWithFreeBet should revert when freeBetsHolder is not set (address 0)', async () => {
			await expect(
				roulette
					.connect(player)
					.placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0)
			).to.be.reverted;
		});

		it('setFreeBetsHolder should emit event', async () => {
			await expect(roulette.connect(owner).setFreeBetsHolder(secondAccount.address))
				.to.emit(roulette, 'FreeBetsHolderChanged')
				.withArgs(secondAccount.address);
		});

		it('normal bet isFreeBet should be false', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			expect(await roulette.isFreeBet(1)).to.equal(false);
		});

		it('isFreeBet mapping returns false for non-existent bet', async () => {
			expect(await roulette.isFreeBet(999)).to.equal(false);
		});
	});

	/* ========== PAGINATION ========== */

	describe('Pagination', () => {
		it('getUserBetIds should paginate correctly', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 3n);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ODD_EVEN, 1, ethers.ZeroAddress);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.LOW_HIGH, 0, ethers.ZeroAddress);

			const page1 = await roulette.getUserBetIds(player.address, 0, 2);
			expect(page1.length).to.equal(2);

			const page2 = await roulette.getUserBetIds(player.address, 2, 2);
			expect(page2.length).to.equal(1);
		});

		it('getRecentBetIds should paginate correctly', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 3n);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ODD_EVEN, 1, ethers.ZeroAddress);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.LOW_HIGH, 0, ethers.ZeroAddress);

			const page = await roulette.getRecentBetIds(1, 1);
			expect(page.length).to.equal(1);
			// Skip most recent (bet 3), get bet 2
			const bet = await roulette.getBetDetails(page[0]);
			expect(bet.betPicks[0].betType).to.equal(BigInt(BetType.ODD_EVEN));
		});
	});

	/* ========== BET HISTORY ========== */

	describe('Bet History', () => {
		it('getUserBetCount should return 0 for new user', async () => {
			expect(await roulette.getUserBetCount(player.address)).to.equal(0n);
		});

		it('getUserBetCount should increment after placing bets', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			expect(await roulette.getUserBetCount(player.address)).to.equal(1n);

			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ODD_EVEN, 1, ethers.ZeroAddress);
			expect(await roulette.getUserBetCount(player.address)).to.equal(2n);
		});

		it('getUserBetIds should return bet IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ODD_EVEN, 1, ethers.ZeroAddress);

			const ids = await roulette.getUserBetIds(player.address, 0, 10);
			expect(ids.length).to.equal(2);
			const bet0 = await roulette.getBetDetails(ids[0]);
			const bet1 = await roulette.getBetDetails(ids[1]);
			expect(bet0.betPicks[0].betType).to.equal(BigInt(BetType.ODD_EVEN));
			expect(bet1.betPicks[0].betType).to.equal(BigInt(BetType.RED_BLACK));
		});

		it('getUserBetIds should return empty for offset beyond length', async () => {
			const ids = await roulette.getUserBetIds(player.address, 100, 10);
			expect(ids.length).to.equal(0);
		});

		it('getRecentBetIds should return bet IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ODD_EVEN, 1, ethers.ZeroAddress);

			const ids = await roulette.getRecentBetIds(0, 10);
			expect(ids.length).to.equal(2);
			const bet0 = await roulette.getBetBase(ids[0]);
			expect(bet0.user).to.equal(player.address);
		});

		it('should not include other users bets in getUserBetIds', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);

			expect(await roulette.getUserBetCount(secondAccount.address)).to.equal(0n);
		});

		it('getRecentBetIds should return empty when offset >= total', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);

			const ids = await roulette.getRecentBetIds(100, 10);
			expect(ids.length).to.equal(0);
		});
	});

	/* ========== FREE BET WIN RESOLUTION ========== */

	describe('FreeBet Win Resolution', () => {
		it('should send profit to user and stake to holder owner on freebet win', async () => {
			// Deploy FreeBetsHolder inline
			const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
			const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
			await holder.initialize(owner.address, owner.address, owner.address);
			const holderAddress = await holder.getAddress();
			await holder.addSupportedCollateral(usdcAddress, true, owner.address);
			await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));

			// Set holder on roulette
			await roulette.connect(owner).setFreeBetsHolder(holderAddress);
			// Whitelist roulette in holder
			await holder.setWhitelistedCasino(rouletteAddress, true);

			// Fund holder with USDC
			await usdc.connect(owner).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(owner).fund(player.address, usdcAddress, MIN_USDC_BET);

			// Place freebet: RED_BLACK selection=0 (red)
			const tx = await roulette
				.connect(player)
				.placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0);
			const { betId, requestId } = await parseBetPlaced(roulette, tx);

			expect(await roulette.isFreeBet(betId)).to.equal(true);

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);
			const ownerBalBefore = await usdc.balanceOf(owner.address);

			// RED_BLACK selection=0 (red): result=1 is red -> win. randomWord % 38 = 1
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

			const betDetails = await roulette.getBetDetails(betId);
			const betBase = await roulette.getBetBase(betId);
			expect(betDetails.won).to.equal(true);

			// Player gets profit (payout - amount)
			const profit = betBase.payout - MIN_USDC_BET;
			const playerBalAfter = await usdc.balanceOf(player.address);
			expect(playerBalAfter - playerBalBefore).to.equal(profit);

			// Stake is forwarded to holder owner; holder itself nets zero
			const holderBalAfter = await usdc.balanceOf(holderAddress);
			expect(holderBalAfter - holderBalBefore).to.equal(0n);
			const ownerBalAfter = await usdc.balanceOf(owner.address);
			expect(ownerBalAfter - ownerBalBefore).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== REFERRALS ========== */

	describe('Referrals', () => {
		let mockReferrals, mockReferralsAddress;
		const REFERRER_FEE = ethers.parseEther('0.005'); // 0.5%
		const ONE = ethers.parseEther('1');

		beforeEach(async () => {
			const MockReferralsFactory = await ethers.getContractFactory('MockReferrals');
			mockReferrals = await MockReferralsFactory.deploy();
			mockReferralsAddress = await mockReferrals.getAddress();
			await mockReferrals.setReferrerFees(REFERRER_FEE, REFERRER_FEE, REFERRER_FEE);
			await roulette.setReferrals(mockReferralsAddress);
		});

		it('should set referrer on placeBet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, secondAccount.address);
			expect(await mockReferrals.referrals(player.address)).to.equal(secondAccount.address);
		});

		it('should NOT set referrer when zero address', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			expect(await mockReferrals.referrals(player.address)).to.equal(ethers.ZeroAddress);
		});

		it('should pay referrer on losing bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, secondAccount.address);
			const { requestId } = await parseBetPlaced(roulette, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			// Selected red (0), randomWord=2 -> black -> loses
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [2n]);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			expect(referrerBalAfter - referrerBalBefore).to.equal(expectedFee);
		});

		it('should emit ReferrerPaid on losing bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, secondAccount.address);
			const { requestId } = await parseBetPlaced(roulette, tx);

			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [2n]))
				.to.emit(roulette, 'ReferrerPaid')
				.withArgs(secondAccount.address, player.address, expectedFee, MIN_USDC_BET, usdcAddress);
		});

		it('should NOT pay referrer on winning bet', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, secondAccount.address);
			const { requestId } = await parseBetPlaced(roulette, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			// Selected red (0), randomWord=1 -> red -> wins
			await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			expect(referrerBalAfter - referrerBalBefore).to.equal(0n);
		});

		it('should NOT pay if no referrer set', async () => {
			await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
			const tx = await roulette
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
			const { requestId } = await parseBetPlaced(roulette, tx);

			await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [2n])).to.not.be
				.reverted;
		});

		it('setReferrals should emit event', async () => {
			await expect(roulette.connect(owner).setReferrals(secondAccount.address))
				.to.emit(roulette, 'ReferralsChanged')
				.withArgs(secondAccount.address);
		});
	});

	/* ========== MULTI-PICK BETS ========== */

	describe('Multi-Pick Bets', () => {
		// Build a PickInput tuple the way ethers expects for a Solidity struct
		const pick = (betType, selection, amount) => ({ betType, selection, amount });

		describe('placeMultiBet', () => {
			it('places a 2-pick USDC bet with different types and amounts', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);

				const picks = [
					pick(BetType.RED_BLACK, 0, MIN_USDC_BET),
					pick(BetType.DOZEN, 0, MIN_USDC_BET),
				];

				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const { betId, requestId } = await parseBetPlaced(roulette, tx);
				expect(betId).to.equal(1n);
				expect(requestId).to.equal(1n);

				// Bet aggregate stake = sum of pick amounts
				const betBase = await roulette.getBetBase(betId);
				expect(betBase.amount).to.equal(MIN_USDC_BET * 2n);
				// Aggregate reserved profit = 1x (RED_BLACK) + 2x (DOZEN) of per-pick amounts
				expect(betBase.reservedProfit).to.equal(MIN_USDC_BET * 3n);
				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(MIN_USDC_BET * 3n);

				// Pick count and contents
				expect(await roulette.getBetPickCount(betId)).to.equal(2n);
				const details = await roulette.getBetDetails(betId);
				expect(details.betPicks.length).to.equal(2);
				expect(details.betPicks[0].betType).to.equal(BigInt(BetType.RED_BLACK));
				expect(details.betPicks[0].amount).to.equal(MIN_USDC_BET);
				expect(details.betPicks[0].reservedProfit).to.equal(MIN_USDC_BET);
				expect(details.betPicks[1].betType).to.equal(BigInt(BetType.DOZEN));
				expect(details.betPicks[1].amount).to.equal(MIN_USDC_BET);
				expect(details.betPicks[1].reservedProfit).to.equal(MIN_USDC_BET * 2n);
			});

			it('emits MultiBetPlaced alongside BetPlaced for multi-pick bets', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);

				const picks = [
					pick(BetType.RED_BLACK, 0, MIN_USDC_BET),
					pick(BetType.ODD_EVEN, 1, MIN_USDC_BET),
				];

				await expect(roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress))
					.to.emit(roulette, 'MultiBetPlaced')
					.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET * 2n, 2, false)
					.and.to.emit(roulette, 'BetPlaced');
			});

			it('does not emit MultiBetPlaced for single-pick placeBet (back-compat)', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);

				const tx = await roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);
				const receipt = await tx.wait();
				const hasMulti = receipt.logs.some((log) => {
					try {
						return roulette.interface.parseLog(log)?.name === 'MultiBetPlaced';
					} catch {
						return false;
					}
				});
				expect(hasMulti).to.equal(false);
			});

			it('single-pick bet shows pickCount=1 and a synthesized 1-element picks array', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);

				await roulette
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.RED_BLACK, 0, ethers.ZeroAddress);

				expect(await roulette.getBetPickCount(1n)).to.equal(1n);
				const details = await roulette.getBetDetails(1n);
				expect(details.betPicks.length).to.equal(1);
				expect(details.betPicks[0].betType).to.equal(BigInt(BetType.RED_BLACK));
				expect(details.betPicks[0].selection).to.equal(0n);
				expect(details.betPicks[0].amount).to.equal(MIN_USDC_BET);
			});

			it('places the maximum 10 picks', async () => {
				// 10 tiny picks of RED_BLACK on alternating colors, each 1 USDC
				const amount = 1n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 10n);
				const picks = Array.from({ length: 10 }, (_, i) => pick(BetType.RED_BLACK, i % 2, amount));

				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const { betId } = await parseBetPlaced(roulette, tx);

				expect(await roulette.getBetPickCount(betId)).to.equal(10n);
				const betBase = await roulette.getBetBase(betId);
				expect(betBase.amount).to.equal(amount * 10n);
				// Each RED_BLACK reserves 1x = amount, so total reserved = 10 * amount
				expect(betBase.reservedProfit).to.equal(amount * 10n);
			});

			it('allows duplicate picks (stacked weight on the same selection)', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);
				const picks = [
					pick(BetType.RED_BLACK, 0, MIN_USDC_BET),
					pick(BetType.RED_BLACK, 0, MIN_USDC_BET),
				];

				await roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const details = await roulette.getBetDetails(1n);
				expect(details.betPicks.length).to.equal(2);
				expect(details.betPicks[0].selection).to.equal(0n);
				expect(details.betPicks[1].selection).to.equal(0n);
			});

			it('places a 1-pick multi-bet (equivalent to placeBet)', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
				const picks = [pick(BetType.RED_BLACK, 0, MIN_USDC_BET)];

				await roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				expect(await roulette.getBetPickCount(1n)).to.equal(1n);
				const betBase = await roulette.getBetBase(1n);
				expect(betBase.amount).to.equal(MIN_USDC_BET);
			});
		});

		describe('placeMultiBet validations', () => {
			it('reverts on empty picks array', async () => {
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, [], ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InvalidPickCount');
			});

			it('reverts on >10 picks', async () => {
				const amount = 1n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 11n);
				const picks = Array.from({ length: 11 }, (_, i) => pick(BetType.RED_BLACK, i % 2, amount));
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InvalidPickCount');
			});

			it('reverts when a pick has zero amount', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET);
				const picks = [pick(BetType.RED_BLACK, 0, MIN_USDC_BET), pick(BetType.DOZEN, 0, 0)];
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InvalidAmount');
			});

			it('reverts when a pick has invalid selection value', async () => {
				await usdc.connect(player).approve(rouletteAddress, MIN_USDC_BET * 2n);
				const picks = [
					pick(BetType.RED_BLACK, 0, MIN_USDC_BET),
					pick(BetType.DOZEN, 3, MIN_USDC_BET),
				];
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InvalidSelection');
			});

			it('reverts on unsupported collateral', async () => {
				const picks = [pick(BetType.RED_BLACK, 0, MIN_USDC_BET)];
				await expect(
					roulette.connect(player).placeMultiBet(secondAccount.address, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InvalidCollateral');
			});

			it('reverts when aggregate stake is below MIN_BET_USD', async () => {
				// Two picks of 1 USDC each (2 USD total, below the 3 USD minimum)
				const amount = 1n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.RED_BLACK, 1, amount)];
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InvalidAmount');
			});

			it('accepts a pick with stake individually below MIN_BET_USD when the aggregate meets it', async () => {
				// Two picks of 2 USDC each => 4 USD total, each pick is only 2 USD
				const amount = 2n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.RED_BLACK, 1, amount)];
				await expect(roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress))
					.to.not.be.reverted;
			});

			it('reverts when aggregate profit exceeds maxProfitUsd', async () => {
				// maxProfitUsd = 1000 USD; one STRAIGHT at 30 USDC reserves 35*30 = 1050 USD profit
				const amount = 30n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount);
				const picks = [pick(BetType.STRAIGHT, 7, amount)];
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'MaxProfitExceeded');
			});

			it('reverts when aggregate profit exceeds maxProfitUsd across multiple picks', async () => {
				// Two STRAIGHTs at 20 USDC each => 2 * 35 * 20 = 1400 USD profit (> 1000 cap)
				const amount = 20n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.STRAIGHT, 7, amount), pick(BetType.STRAIGHT, 13, amount)];
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'MaxProfitExceeded');
			});

			it('rolls back reservation when liquidity is insufficient', async () => {
				// Drain most of the USDC bankroll so the next placement trips the liquidity check.
				// STRAIGHT reserves 35x, so a 14 USDC STRAIGHT reserves 490 USDC profit.
				const remainingBankroll = 10n * 1_000_000n;
				const currentBal = await usdc.balanceOf(rouletteAddress);
				await roulette
					.connect(owner)
					.withdrawCollateral(usdcAddress, owner.address, currentBal - remainingBankroll);

				// Multi-bet that aggregates enough reservation to exceed bankroll after stake transfer
				const amount = 14n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.STRAIGHT, 7, amount), pick(BetType.STRAIGHT, 13, amount)];
				await expect(
					roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress)
				).to.be.revertedWithCustomError(roulette, 'InsufficientAvailableLiquidity');

				// Reservation was rolled back
				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
			});
		});

		describe('Multi-pick fulfillment', () => {
			it('all picks win: totalPayout = sum of leg payouts; Bet.won=true', async () => {
				// Result = 7 (red, odd, 1-18, STRAIGHT=7 hits)
				// Picks: STRAIGHT=7 (wins 36x), RED_BLACK=0 red (wins 2x), LOW_HIGH=0 (wins 2x)
				const amount = 1n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 3n);
				const picks = [
					pick(BetType.STRAIGHT, 7, amount),
					pick(BetType.RED_BLACK, 0, amount),
					pick(BetType.LOW_HIGH, 0, amount),
				];
				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const { betId, requestId } = await parseBetPlaced(roulette, tx);

				const balBefore = await usdc.balanceOf(player.address);
				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [7n]);

				const betBase = await roulette.getBetBase(betId);
				// Expected payout: 36*amount (STRAIGHT) + 2*amount (RED_BLACK) + 2*amount (LOW_HIGH) = 40*amount
				expect(betBase.payout).to.equal(amount * 40n);
				const balAfter = await usdc.balanceOf(player.address);
				expect(balAfter - balBefore).to.equal(amount * 40n);

				const details = await roulette.getBetDetails(betId);
				expect(details.won).to.equal(true);
				expect(details.status).to.equal(2n); // RESOLVED
				expect(details.result).to.equal(7n);
				expect(details.betPicks.every((p) => p.won)).to.equal(true);

				// Reservation released
				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
			});

			it('partial win: only winning picks pay out, single aggregate transfer', async () => {
				// Result = 1 (red, odd, 1-18, STRAIGHT=1)
				// Picks: STRAIGHT=5 (loses), RED_BLACK=0 red (wins), ODD_EVEN=1 even (loses)
				const amount = 1n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 3n);
				const picks = [
					pick(BetType.STRAIGHT, 5, amount),
					pick(BetType.RED_BLACK, 0, amount),
					pick(BetType.ODD_EVEN, 1, amount),
				];
				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const { betId, requestId } = await parseBetPlaced(roulette, tx);

				const balBefore = await usdc.balanceOf(player.address);
				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

				const betBase = await roulette.getBetBase(betId);
				// Only RED_BLACK wins: payout = 2 * amount
				expect(betBase.payout).to.equal(amount * 2n);
				const balAfter = await usdc.balanceOf(player.address);
				expect(balAfter - balBefore).to.equal(amount * 2n);

				const details = await roulette.getBetDetails(betId);
				expect(details.won).to.equal(true); // any pick won
				expect(details.betPicks[0].won).to.equal(false);
				expect(details.betPicks[0].payout).to.equal(0n);
				expect(details.betPicks[1].won).to.equal(true);
				expect(details.betPicks[1].payout).to.equal(amount * 2n);
				expect(details.betPicks[2].won).to.equal(false);
				expect(details.betPicks[2].payout).to.equal(0n);

				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
			});

			it('all picks lose: no payout, referrer paid on totalAmount', async () => {
				// Set up referrer with 0.5% fee
				const MockReferralsFactory = await ethers.getContractFactory('MockReferrals');
				const mockReferrals = await MockReferralsFactory.deploy();
				const fee = ethers.parseEther('0.005');
				await mockReferrals.setReferrerFees(fee, fee, fee);
				await roulette.connect(owner).setReferrals(await mockReferrals.getAddress());

				// Pick all selections that lose on result=0
				const amount = 1n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 3n);
				const picks = [
					pick(BetType.RED_BLACK, 0, amount),
					pick(BetType.ODD_EVEN, 1, amount),
					pick(BetType.LOW_HIGH, 0, amount),
				];
				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, secondAccount.address);
				const { betId, requestId } = await parseBetPlaced(roulette, tx);

				const playerBefore = await usdc.balanceOf(player.address);
				const refBefore = await usdc.balanceOf(secondAccount.address);

				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [0n]); // zero kills all

				const betBase = await roulette.getBetBase(betId);
				expect(betBase.payout).to.equal(0n);
				expect(await usdc.balanceOf(player.address)).to.equal(playerBefore);

				// Referrer gets 0.5% of totalAmount (3 USDC)
				const refAfter = await usdc.balanceOf(secondAccount.address);
				expect(refAfter - refBefore).to.equal((amount * 3n * 5n) / 1000n);

				const details = await roulette.getBetDetails(betId);
				expect(details.won).to.equal(false);
				expect(details.betPicks.every((p) => !p.won)).to.equal(true);
			});

			it('does not pay referrer when any pick wins', async () => {
				const MockReferralsFactory = await ethers.getContractFactory('MockReferrals');
				const mockReferrals = await MockReferralsFactory.deploy();
				const fee = ethers.parseEther('0.005');
				await mockReferrals.setReferrerFees(fee, fee, fee);
				await roulette.connect(owner).setReferrals(await mockReferrals.getAddress());

				// Partial win scenario — referrer should NOT be paid.
				// Small STRAIGHT + larger RED_BLACK so aggregate stake hits MIN_BET_USD but reserved
				// profit stays well under bankroll
				const strAmount = 1n * 1_000_000n;
				const rbAmount = 2n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, strAmount + rbAmount);
				const picks = [pick(BetType.STRAIGHT, 5, strAmount), pick(BetType.RED_BLACK, 0, rbAmount)];
				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, secondAccount.address);
				const { requestId } = await parseBetPlaced(roulette, tx);

				const refBefore = await usdc.balanceOf(secondAccount.address);
				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]); // RED_BLACK wins
				const refAfter = await usdc.balanceOf(secondAccount.address);
				expect(refAfter - refBefore).to.equal(0n);
			});

			it('emits a single BetResolved event with aggregate payout and releases full reservation', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.DOZEN, 0, amount)];
				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const { betId, requestId } = await parseBetPlaced(roulette, tx);

				// Reservation should be 1x + 2x = 3x amount
				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(amount * 3n);

				// Result = 1 (red, dozen 1-12): both picks win → payout = 2*amount + 3*amount = 5*amount
				await expect(vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]))
					.to.emit(roulette, 'BetResolved')
					.withArgs(betId, requestId, player.address, 1, true, amount * 5n);

				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
			});
		});

		describe('Multi-pick free bet', () => {
			let holder, holderAddress;

			beforeEach(async () => {
				const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
				holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
				await holder.initialize(owner.address, owner.address, owner.address);
				holderAddress = await holder.getAddress();
				await holder.addSupportedCollateral(usdcAddress, true, owner.address);
				await holder.setFreeBetExpirationPeriod(86400, Math.floor(Date.now() / 1000));
				await roulette.connect(owner).setFreeBetsHolder(holderAddress);
				await holder.setWhitelistedCasino(rouletteAddress, true);
			});

			it('deducts aggregate amount from holder balance on placement', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(owner).approve(holderAddress, amount * 2n);
				await holder.connect(owner).fund(player.address, usdcAddress, amount * 2n);

				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.DOZEN, 0, amount)];
				await roulette.connect(player).placeMultiBetWithFreeBet(usdcAddress, picks);

				expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
				expect(await roulette.isFreeBet(1n)).to.equal(true);
			});

			it('full win: sends aggregate payout to holder; profit → user, stake → holder owner', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(owner).approve(holderAddress, amount * 2n);
				await holder.connect(owner).fund(player.address, usdcAddress, amount * 2n);

				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.DOZEN, 0, amount)];
				const tx = await roulette.connect(player).placeMultiBetWithFreeBet(usdcAddress, picks);
				const { betId, requestId } = await parseBetPlaced(roulette, tx);

				const playerBefore = await usdc.balanceOf(player.address);
				const ownerBefore = await usdc.balanceOf(owner.address);

				// Result = 1: RED_BLACK wins (2*amount), DOZEN wins (3*amount) → total 5*amount
				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

				const betBase = await roulette.getBetBase(betId);
				expect(betBase.payout).to.equal(amount * 5n);

				// Stake (totalAmount = 2*amount) → holder owner; profit (5*amount - 2*amount = 3*amount) → user
				const playerAfter = await usdc.balanceOf(player.address);
				expect(playerAfter - playerBefore).to.equal(amount * 3n);
				const ownerAfter = await usdc.balanceOf(owner.address);
				expect(ownerAfter - ownerBefore).to.equal(amount * 2n);
			});

			it('partial win: payout credited back to holder free-bet balance', async () => {
				// Three picks of 1 USDC each: RED_BLACK=0 wins on result=1, the other two lose.
				// totalAmount = 3 USDC, winning leg payout = 2 USDC → 2 < 3, so credited back to holder balance
				const amount = 1n * 1_000_000n;
				const totalStake = amount * 3n;
				await usdc.connect(owner).approve(holderAddress, totalStake);
				await holder.connect(owner).fund(player.address, usdcAddress, totalStake);

				const picks = [
					pick(BetType.STRAIGHT, 5, amount),
					pick(BetType.ODD_EVEN, 1, amount),
					pick(BetType.RED_BLACK, 0, amount),
				];
				const tx = await roulette.connect(player).placeMultiBetWithFreeBet(usdcAddress, picks);
				const { requestId } = await parseBetPlaced(roulette, tx);

				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [1n]);

				// Winning leg (RED_BLACK) payout = 2 * amount = 2 USDC; 2 < 3 → credited back
				expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(
					amount * 2n
				);
			});

			it('full loss: no transfer to holder (stake consumed)', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(owner).approve(holderAddress, amount * 2n);
				await holder.connect(owner).fund(player.address, usdcAddress, amount * 2n);

				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.RED_BLACK, 0, amount)];
				const tx = await roulette.connect(player).placeMultiBetWithFreeBet(usdcAddress, picks);
				const { requestId } = await parseBetPlaced(roulette, tx);

				const holderBefore = await usdc.balanceOf(holderAddress);
				// Result = 0 (zero) → both RED picks lose
				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [0n]);
				const holderAfter = await usdc.balanceOf(holderAddress);
				expect(holderAfter - holderBefore).to.equal(0n);
				expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
			});
		});

		describe('Multi-pick cancel', () => {
			it('user cancel after timeout refunds aggregate stake and releases reservation', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.DOZEN, 0, amount)];
				await roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);

				// Fast-forward past cancel timeout
				await time.increase(CANCEL_TIMEOUT + 1n);

				const balBefore = await usdc.balanceOf(player.address);
				await expect(roulette.connect(player).cancelBet(1n))
					.to.emit(roulette, 'BetCancelled')
					.withArgs(1n, 1n, player.address, amount * 2n, false);

				expect(await usdc.balanceOf(player.address)).to.equal(balBefore + amount * 2n);
				expect(await roulette.reservedProfitPerCollateral(usdcAddress)).to.equal(0n);
			});

			it('admin cancel works regardless of timeout', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.DOZEN, 0, amount)];
				await roulette.connect(player).placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);

				const balBefore = await usdc.balanceOf(player.address);
				await roulette.connect(owner).adminCancelBet(1n);
				expect(await usdc.balanceOf(player.address)).to.equal(balBefore + amount * 2n);
			});

			it('cannot cancel after resolution', async () => {
				const amount = 2n * 1_000_000n;
				await usdc.connect(player).approve(rouletteAddress, amount * 2n);
				const picks = [pick(BetType.RED_BLACK, 0, amount), pick(BetType.DOZEN, 0, amount)];
				const tx = await roulette
					.connect(player)
					.placeMultiBet(usdcAddress, picks, ethers.ZeroAddress);
				const { requestId } = await parseBetPlaced(roulette, tx);
				await vrfCoordinator.fulfillRandomWords(rouletteAddress, requestId, [0n]);

				await time.increase(CANCEL_TIMEOUT + 1n);
				await expect(roulette.connect(player).cancelBet(1n)).to.be.revertedWithCustomError(
					roulette,
					'BetNotPending'
				);
			});
		});

		describe('Multi-pick views', () => {
			it('quoteMultiBet returns correct aggregates', async () => {
				const amount = 2n * 1_000_000n;
				const picks = [
					pick(BetType.RED_BLACK, 0, amount), // 1x
					pick(BetType.DOZEN, 0, amount), // 2x
					pick(BetType.STRAIGHT, 7, amount), // 35x
				];
				const q = await roulette.quoteMultiBet(usdcAddress, picks);
				expect(q.totalAmount).to.equal(amount * 3n);
				expect(q.totalProfitCollateral).to.equal(amount * (1n + 2n + 35n));
				// 1 USDC = 1 USD → totalProfitUsd = totalProfitCollateral scaled to 18-dec
				const expectedUsd = (amount * 38n * ethers.parseEther('1')) / 1_000_000n;
				expect(q.totalProfitUsd).to.equal(expectedUsd);
			});

			it('quoteMultiBet reverts on invalid pick count', async () => {
				await expect(roulette.quoteMultiBet(usdcAddress, [])).to.be.revertedWithCustomError(
					roulette,
					'InvalidPickCount'
				);
			});

			it('quoteMultiBet reverts on unsupported collateral', async () => {
				const picks = [pick(BetType.RED_BLACK, 0, 1n)];
				await expect(
					roulette.quoteMultiBet(secondAccount.address, picks)
				).to.be.revertedWithCustomError(roulette, 'InvalidCollateral');
			});

			it('MAX_PICKS_PER_BET constant is exposed as 10', async () => {
				expect(await roulette.MAX_PICKS_PER_BET()).to.equal(10n);
			});
		});
	});
});
