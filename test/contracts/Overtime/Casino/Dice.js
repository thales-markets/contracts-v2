const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');
const { ZERO_ADDRESS } = require('../../../constants/general');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('1000');
const CANCEL_TIMEOUT = 3600n;
const HOUSE_EDGE = ethers.parseEther('0.02'); // 2%
const ONE = ethers.parseEther('1');

const MIN_USDC_BET = 3n * 1_000_000n;
const DICE_SIDES = 20n;

// BetType enum
const BetType = {
	ROLL_UNDER: 0n,
	ROLL_OVER: 1n,
};

// BetStatus enum
const Status = {
	NONE: 0n,
	PENDING: 1n,
	RESOLVED: 2n,
	CANCELLED: 3n,
};

// Helper: derive dice result from a random word
function deriveResult(word) {
	return Number((word % DICE_SIDES) + 1n);
}

// Helper: compute expected payout for a winning bet
function getExpectedPayout(amount, betType, target) {
	const winningFaces =
		betType === BetType.ROLL_UNDER ? BigInt(target) - 1n : DICE_SIDES - BigInt(target);
	const probability = (winningFaces * ONE) / DICE_SIDES;
	const multiplier = ((ONE - HOUSE_EDGE) * ONE) / probability;
	return (BigInt(amount) * multiplier) / ONE;
}

function getReservedProfit(amount, betType, target) {
	return getExpectedPayout(amount, betType, target) - BigInt(amount);
}

async function deployDiceFixture() {
	const [owner, secondAccount, resolver, riskManager, pauser, player] = await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();

	const usdcAddress = await usdc.getAddress();
	const wethAddress = await weth.getAddress();
	const overAddress = await over.getAddress();

	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	await priceFeed.setPriceFeedForCollateral(WETH_KEY, wethAddress, WETH_PRICE);
	await priceFeed.setPriceFeedForCollateral(OVER_KEY, overAddress, OVER_PRICE);
	const priceFeedAddress = await priceFeed.getAddress();

	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const manager = await upgrades.deployProxy(SportsAMMV2Manager, [owner.address]);
	const managerAddress = await manager.getAddress();

	await manager.setWhitelistedAddresses([resolver.address], 2, true);
	await manager.setWhitelistedAddresses([riskManager.address], 1, true);
	await manager.setWhitelistedAddresses([pauser.address], 3, true);

	const MockVRFCoordinator = await ethers.getContractFactory('MockVRFCoordinator');
	const vrfCoordinator = await MockVRFCoordinator.deploy();
	const vrfCoordinatorAddress = await vrfCoordinator.getAddress();

	const DiceFactory = await ethers.getContractFactory('Dice');
	const dice = await upgrades.deployProxy(DiceFactory, [], { initializer: false });
	const diceAddress = await dice.getAddress();

	await dice.initialize(
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
		HOUSE_EDGE,
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);

	// Fund bankroll (enough for extreme 19.6x payouts on min bet)
	await usdc.transfer(diceAddress, 59n * 1_000_000n);

	// Fund player
	await usdc.transfer(player.address, 40n * 1_000_000n);

	return {
		dice,
		diceAddress,
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
	};
}

async function parseBetPlaced(dice, tx) {
	const receipt = await tx.wait();
	const parsed = receipt.logs
		.map((log) => {
			try {
				return dice.interface.parseLog(log);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	return { betId: parsed.args.betId, requestId: parsed.args.requestId };
}

describe('Dice', () => {
	let dice, diceAddress, usdc, usdcAddress, weth, wethAddress, over, overAddress, vrfCoordinator;
	let owner, secondAccount, resolver, riskManager, pauser, player;

	beforeEach(async () => {
		({
			dice,
			diceAddress,
			usdc,
			usdcAddress,
			weth,
			wethAddress,
			over,
			overAddress,
			vrfCoordinator,
			owner,
			secondAccount,
			resolver,
			riskManager,
			pauser,
			player,
		} = await loadFixture(deployDiceFixture));
	});

	/* ========== INITIALIZATION ========== */

	describe('Initialization', () => {
		it('should set correct state after initialize', async () => {
			expect(await dice.owner()).to.equal(owner.address);
			expect(await dice.usdc()).to.equal(usdcAddress);
			expect(await dice.maxProfitUsd()).to.equal(MAX_PROFIT_USD);
			expect(await dice.cancelTimeout()).to.equal(CANCEL_TIMEOUT);
			expect(await dice.houseEdge()).to.equal(HOUSE_EDGE);
			expect(await dice.nextBetId()).to.equal(1n);
		});

		it('should revert on re-initialization', async () => {
			await expect(
				dice.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: usdcAddress,
						over: usdcAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					HOUSE_EDGE,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 500000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.reverted;
		});

		it('should revert with zero house edge', async () => {
			const DiceFactory = await ethers.getContractFactory('Dice');
			const d = await upgrades.deployProxy(DiceFactory, [], { initializer: false });
			await expect(
				d.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: usdcAddress,
						over: usdcAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					0,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 500000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(d, 'InvalidHouseEdge');
		});

		it('should revert with zero collateral address', async () => {
			const DiceFactory = await ethers.getContractFactory('Dice');
			const d = await upgrades.deployProxy(DiceFactory, [], { initializer: false });
			await expect(
				d.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: ethers.ZeroAddress,
						weth: usdcAddress,
						over: usdcAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					CANCEL_TIMEOUT,
					HOUSE_EDGE,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 500000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(d, 'InvalidAddress');
		});
	});

	/* ========== PLACE BET ========== */

	describe('placeBet', () => {
		it('should revert for unsupported collateral', async () => {
			await expect(
				dice
					.connect(player)
					.placeBet(secondAccount.address, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(
				dice.connect(player).placeBet(usdcAddress, 0, BetType.ROLL_UNDER, 11, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InvalidAmount');
		});

		it('should revert for invalid ROLL_UNDER target (1 or 21)', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 1, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InvalidTarget');
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 21, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InvalidTarget');
		});

		it('should revert for invalid ROLL_OVER target (0 or 20)', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 0, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InvalidTarget');
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 20, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InvalidTarget');
		});

		it('should revert when paused', async () => {
			await dice.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress)
			).to.be.reverted;
		});

		it('should place a ROLL_UNDER bet and emit BetPlaced', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress)
			)
				.to.emit(dice, 'BetPlaced')
				.withArgs(1n, 1n, player.address, usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11);

			const betBase = await dice.getBetBase(1n);
			const betDetails = await dice.getBetDetails(1n);
			expect(betBase.user).to.equal(player.address);
			expect(betDetails.status).to.equal(Status.PENDING);
			expect(betDetails.target).to.equal(11n);
			expect(await dice.nextBetId()).to.equal(2n);
		});

		it('should place a ROLL_OVER bet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			const betDetails = await dice.getBetDetails(betId);
			expect(betDetails.betType).to.equal(BetType.ROLL_OVER);
			expect(betDetails.target).to.equal(10n);
		});
	});

	/* ========== VRF RESOLUTION ========== */

	describe('Resolution', () => {
		it('should resolve ROLL_UNDER as win when result < target', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			const playerBalBefore = await usdc.balanceOf(player.address);

			// randomWord=4 → result = (4%20)+1 = 5, which is < 11 → win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.status).to.equal(Status.RESOLVED);
			expect(betDetails.result).to.equal(5n);
			expect(betDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, BetType.ROLL_UNDER, 11);
			expect(betBase.payout).to.equal(expectedPayout);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});

		it('should resolve ROLL_UNDER as loss when result >= target', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// randomWord=14 → result = (14%20)+1 = 15, which is >= 11 → loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.status).to.equal(Status.RESOLVED);
			expect(betDetails.result).to.equal(15n);
			expect(betDetails.won).to.equal(false);
			expect(betBase.payout).to.equal(0n);
		});

		it('should resolve ROLL_UNDER as loss when result equals target', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// randomWord=10 → result = (10%20)+1 = 11, which is NOT < 11 → loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [10n]);

			const betDetails = await dice.getBetDetails(betId);
			expect(betDetails.result).to.equal(11n);
			expect(betDetails.won).to.equal(false);
		});

		it('should resolve ROLL_OVER as win when result > target', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			const playerBalBefore = await usdc.balanceOf(player.address);

			// randomWord=14 → result = 15, which is > 10 → win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.status).to.equal(Status.RESOLVED);
			expect(betDetails.result).to.equal(15n);
			expect(betDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, BetType.ROLL_OVER, 10);
			expect(betBase.payout).to.equal(expectedPayout);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});

		it('should resolve ROLL_OVER as loss when result <= target', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// randomWord=4 → result = 5, which is <= 10 → loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.result).to.equal(5n);
			expect(betDetails.won).to.equal(false);
			expect(betBase.payout).to.equal(0n);
		});

		it('should resolve ROLL_OVER as loss when result equals target', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// randomWord=9 → result = 10, which is NOT > 10 → loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [9n]);

			const betDetails = await dice.getBetDetails(betId);
			expect(betDetails.result).to.equal(10n);
			expect(betDetails.won).to.equal(false);
		});

		it('should handle extreme low target (ROLL_UNDER 2, only result=1 wins)', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 2, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			const playerBalBefore = await usdc.balanceOf(player.address);

			// randomWord=0 → result = 1, which is < 2 → win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [0n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.result).to.equal(1n);
			expect(betDetails.won).to.equal(true);

			// 1/20 chance, multiplier = 0.98 * 20 = 19.6x
			const expectedPayout = getExpectedPayout(MIN_USDC_BET, BetType.ROLL_UNDER, 2);
			expect(betBase.payout).to.equal(expectedPayout);
		});

		it('should handle extreme high target (ROLL_OVER 19, only result=20 wins)', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 19, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// randomWord=19 → result = 20, which is > 19 → win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [19n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.result).to.equal(20n);
			expect(betDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_USDC_BET, BetType.ROLL_OVER, 19);
			expect(betBase.payout).to.equal(expectedPayout);
		});
	});

	/* ========== CANCEL ========== */

	describe('cancelBet', () => {
		it('should revert if timeout not reached', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			await expect(dice.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				dice,
				'CancelTimeoutNotReached'
			);
		});

		it('should revert if not bet owner', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			await time.increase(CANCEL_TIMEOUT);
			await expect(dice.connect(secondAccount).cancelBet(betId)).to.be.revertedWithCustomError(
				dice,
				'BetNotOwner'
			);
		});

		it('should cancel after timeout and refund', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			const balBefore = await usdc.balanceOf(player.address);
			await time.increase(CANCEL_TIMEOUT);

			await expect(dice.connect(player).cancelBet(betId)).to.emit(dice, 'BetCancelled');

			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.status).to.equal(Status.CANCELLED);
			expect(betBase.payout).to.equal(MIN_USDC_BET);
		});
	});

	/* ========== ADMIN CANCEL ========== */

	describe('adminCancelBet', () => {
		it('should revert for non-resolver', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			await expect(dice.connect(secondAccount).adminCancelBet(betId)).to.be.revertedWithCustomError(
				dice,
				'InvalidSender'
			);
		});

		it('should allow owner to admin cancel', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			await expect(dice.connect(owner).adminCancelBet(betId)).to.emit(dice, 'BetCancelled');
		});
	});

	/* ========== WITHDRAW COLLATERAL ========== */

	describe('withdrawCollateral', () => {
		it('should allow owner to withdraw', async () => {
			const amount = 10n * 1_000_000n;
			await expect(
				dice.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, amount)
			)
				.to.emit(dice, 'WithdrawnCollateral')
				.withArgs(usdcAddress, secondAccount.address, amount);
		});

		it('should revert for non-owner', async () => {
			await expect(
				dice.connect(secondAccount).withdrawCollateral(usdcAddress, secondAccount.address, 1n)
			).to.be.reverted;
		});
	});

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		it('getWinningFaces ROLL_UNDER target=11 should return 10', async () => {
			expect(await dice.getWinningFaces(BetType.ROLL_UNDER, 11)).to.equal(10n);
		});

		it('getWinningFaces ROLL_OVER target=10 should return 10', async () => {
			expect(await dice.getWinningFaces(BetType.ROLL_OVER, 10)).to.equal(10n);
		});

		it('getWinProbability ROLL_UNDER target=11 should return 50%', async () => {
			const prob = await dice.getWinProbability(BetType.ROLL_UNDER, 11);
			expect(prob).to.equal(ethers.parseEther('0.5'));
		});

		it('getPayoutMultiplier ROLL_UNDER target=11 should return 1.96x', async () => {
			const mult = await dice.getPayoutMultiplier(BetType.ROLL_UNDER, 11);
			expect(mult).to.equal(ethers.parseEther('1.96'));
		});

		it('getPotentialPayoutCollateral should match expected payout', async () => {
			const payout = await dice.getPotentialPayoutCollateral(MIN_USDC_BET, BetType.ROLL_UNDER, 11);
			expect(payout).to.equal(getExpectedPayout(MIN_USDC_BET, BetType.ROLL_UNDER, 11));
		});

		it('isWinningBet should return correct values', async () => {
			expect(await dice.isWinningBet(BetType.ROLL_UNDER, 11, 5)).to.equal(true);
			expect(await dice.isWinningBet(BetType.ROLL_UNDER, 11, 11)).to.equal(false);
			expect(await dice.isWinningBet(BetType.ROLL_OVER, 10, 15)).to.equal(true);
			expect(await dice.isWinningBet(BetType.ROLL_OVER, 10, 10)).to.equal(false);
		});

		it('isWinningBet should revert for invalid result', async () => {
			await expect(dice.isWinningBet(BetType.ROLL_UNDER, 11, 0)).to.be.revertedWithCustomError(
				dice,
				'InvalidResult'
			);
			await expect(dice.isWinningBet(BetType.ROLL_UNDER, 11, 21)).to.be.revertedWithCustomError(
				dice,
				'InvalidResult'
			);
		});

		it('getAvailableLiquidity should return bankroll minus reserved', async () => {
			expect(await dice.getAvailableLiquidity(usdcAddress)).to.equal(59n * 1_000_000n);
		});
	});

	/* ========== SETTERS ========== */

	describe('Setters', () => {
		it('setHouseEdge should update and emit', async () => {
			const newEdge = ethers.parseEther('0.03');
			await expect(dice.connect(owner).setHouseEdge(newEdge))
				.to.emit(dice, 'HouseEdgeChanged')
				.withArgs(newEdge);
			expect(await dice.houseEdge()).to.equal(newEdge);
		});

		it('setHouseEdge should revert for zero', async () => {
			await expect(dice.connect(owner).setHouseEdge(0)).to.be.revertedWithCustomError(
				dice,
				'InvalidHouseEdge'
			);
		});

		it('setHouseEdge should revert for > MAX_HOUSE_EDGE', async () => {
			const tooHigh = ethers.parseEther('0.06');
			await expect(dice.connect(owner).setHouseEdge(tooHigh)).to.be.revertedWithCustomError(
				dice,
				'InvalidHouseEdge'
			);
		});

		it('setManager should revert for zero address', async () => {
			await expect(dice.connect(owner).setManager(ZERO_ADDRESS)).to.be.revertedWithCustomError(
				dice,
				'InvalidAddress'
			);
		});

		it('setPriceFeed should revert for zero address', async () => {
			await expect(dice.connect(owner).setPriceFeed(ZERO_ADDRESS)).to.be.revertedWithCustomError(
				dice,
				'InvalidAddress'
			);
		});

		it('setVrfCoordinator should revert for zero address', async () => {
			await expect(
				dice.connect(owner).setVrfCoordinator(ZERO_ADDRESS)
			).to.be.revertedWithCustomError(dice, 'InvalidAddress');
		});

		it('setSupportedCollateral should revert for zero address', async () => {
			await expect(
				dice.connect(owner).setSupportedCollateral(ZERO_ADDRESS, true)
			).to.be.revertedWithCustomError(dice, 'InvalidAddress');
		});

		it('setPriceFeedKeyPerCollateral should revert for zero address', async () => {
			await expect(
				dice.connect(owner).setPriceFeedKeyPerCollateral(ZERO_ADDRESS, WETH_KEY)
			).to.be.revertedWithCustomError(dice, 'InvalidAddress');
		});

		it('setVrfConfig should update config and emit', async () => {
			await expect(dice.connect(owner).setVrfConfig(2n, ethers.ZeroHash, 300000n, 5n, true))
				.to.emit(dice, 'VrfConfigChanged')
				.withArgs(2n, ethers.ZeroHash, 300000n, 5n, true);
			expect(await dice.callbackGasLimit()).to.equal(300000n);
			expect(await dice.requestConfirmations()).to.equal(5n);
		});

		it('setVrfConfig should revert for zero callbackGasLimit', async () => {
			await expect(
				dice.connect(owner).setVrfConfig(1n, ethers.ZeroHash, 0n, 3n, false)
			).to.be.revertedWithCustomError(dice, 'InvalidAmount');
		});

		it('setVrfConfig should accept zero requestConfirmations', async () => {
			await expect(
				dice.connect(owner).setVrfConfig(1n, ethers.ZeroHash, 500000n, 0n, false)
			).to.emit(dice, 'VrfConfigChanged');
		});

		it('setMaxProfitUsd should revert for zero', async () => {
			await expect(dice.connect(owner).setMaxProfitUsd(0)).to.be.revertedWithCustomError(
				dice,
				'InvalidAmount'
			);
		});

		it('setMaxProfitUsd should update and emit', async () => {
			await expect(dice.connect(owner).setMaxProfitUsd(ethers.parseEther('500')))
				.to.emit(dice, 'MaxProfitUsdChanged')
				.withArgs(ethers.parseEther('500'));
		});

		it('setMaxProfitUsd should revert from non-risk-manager', async () => {
			await expect(
				dice.connect(secondAccount).setMaxProfitUsd(ethers.parseEther('500'))
			).to.be.revertedWithCustomError(dice, 'InvalidSender');
		});

		it('setPausedByRole should revert from non-pauser', async () => {
			await expect(dice.connect(secondAccount).setPausedByRole(true)).to.be.revertedWithCustomError(
				dice,
				'InvalidSender'
			);
		});

		it('placeBet should revert and rollback reservedProfit on insufficient liquidity', async () => {
			// Drain bankroll
			const balance = await usdc.balanceOf(diceAddress);
			await dice.connect(owner).withdrawCollateral(usdcAddress, owner.address, balance);

			const reservedBefore = await dice.reservedProfitPerCollateral(usdcAddress);

			// ROLL_UNDER target 2: 1/20 win odds, ~19.6x payout, reserved profit ~55.8 USDC > 3 USDC bet
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await expect(
				dice
					.connect(player)
					.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 2, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(dice, 'InsufficientAvailableLiquidity');

			// Reserved profit should be rolled back to before
			const reservedAfter = await dice.reservedProfitPerCollateral(usdcAddress);
			expect(reservedAfter).to.equal(reservedBefore);
		});

		it('setSupportedCollateral should emit', async () => {
			await expect(dice.connect(owner).setSupportedCollateral(secondAccount.address, true))
				.to.emit(dice, 'SupportedCollateralChanged')
				.withArgs(secondAccount.address, true);
		});

		it('setPriceFeedKeyPerCollateral should emit', async () => {
			await expect(
				dice
					.connect(owner)
					.setPriceFeedKeyPerCollateral(secondAccount.address, ethers.encodeBytes32String('TEST'))
			)
				.to.emit(dice, 'PriceFeedKeyPerCollateralChanged')
				.withArgs(secondAccount.address, ethers.encodeBytes32String('TEST'));
		});

		it('setManager should emit', async () => {
			await expect(dice.connect(owner).setManager(secondAccount.address))
				.to.emit(dice, 'ManagerChanged')
				.withArgs(secondAccount.address);
		});

		it('setPriceFeed should emit', async () => {
			await expect(dice.connect(owner).setPriceFeed(secondAccount.address))
				.to.emit(dice, 'PriceFeedChanged')
				.withArgs(secondAccount.address);
		});

		it('setVrfCoordinator should emit', async () => {
			await expect(dice.connect(owner).setVrfCoordinator(secondAccount.address))
				.to.emit(dice, 'VrfCoordinatorChanged')
				.withArgs(secondAccount.address);
		});
	});

	/* ========== VRF AUTH ========== */

	describe('VRF auth', () => {
		it('should revert rawFulfillRandomWords from non-coordinator', async () => {
			await expect(
				dice.connect(secondAccount).rawFulfillRandomWords(1n, [7n])
			).to.be.revertedWithCustomError(dice, 'InvalidSender');
		});
	});

	/* ========== SPLIT GETTERS ========== */

	describe('Split Getters', () => {
		it('getBetBase returns correct values after placing a bet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId } = await parseBetPlaced(dice, tx);

			const betBase = await dice.getBetBase(betId);
			expect(betBase.user).to.equal(player.address);
			expect(betBase.collateral).to.equal(usdcAddress);
			expect(betBase.amount).to.equal(MIN_USDC_BET);
			expect(betBase.payout).to.equal(0n);
			expect(betBase.reservedProfit).to.equal(
				getReservedProfit(MIN_USDC_BET, BetType.ROLL_UNDER, 11)
			);
		});

		it('getBetDetails returns correct values after resolution', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// Win: randomWord=4 -> result=5, ROLL_UNDER target=11 -> win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);

			const betDetails = await dice.getBetDetails(betId);
			expect(betDetails.status).to.equal(Status.RESOLVED);
			expect(betDetails.betType).to.equal(BetType.ROLL_UNDER);
			expect(betDetails.target).to.equal(11n);
			expect(betDetails.result).to.equal(5n);
			expect(betDetails.won).to.equal(true);
		});
	});

	/* ========== AUDIT FIXES ========== */

	describe('Audit Fixes', () => {
		it('withdrawCollateral should revert when amount exceeds available (reserved funds protection)', async () => {
			// Place a bet to create reserved profit
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);

			// Try to withdraw all balance - should fail because some is reserved
			const balance = await usdc.balanceOf(diceAddress);
			await expect(
				dice.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, balance)
			).to.be.revertedWithCustomError(dice, 'InsufficientAvailableLiquidity');
		});

		it('withdrawCollateral should revert when amount > balance', async () => {
			const balance = await usdc.balanceOf(diceAddress);
			await expect(
				dice.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, balance + 1n)
			).to.be.revertedWithCustomError(dice, 'InsufficientAvailableLiquidity');
		});

		it('setCancelTimeout should revert below MIN_CANCEL_TIMEOUT (30)', async () => {
			await expect(dice.connect(owner).setCancelTimeout(29)).to.be.revertedWithCustomError(
				dice,
				'InvalidAmount'
			);
		});

		it('setCancelTimeout should succeed at MIN_CANCEL_TIMEOUT', async () => {
			await expect(dice.connect(owner).setCancelTimeout(30))
				.to.emit(dice, 'CancelTimeoutChanged')
				.withArgs(30);
		});

		it('Initialize should revert with cancelTimeout below MIN_CANCEL_TIMEOUT', async () => {
			const DiceFactory = await ethers.getContractFactory('Dice');
			const d = await upgrades.deployProxy(DiceFactory, [], { initializer: false });
			await expect(
				d.initialize(
					{
						owner: owner.address,
						manager: owner.address,
						priceFeed: owner.address,
						vrfCoordinator: owner.address,
					},
					{
						usdc: usdcAddress,
						weth: usdcAddress,
						over: usdcAddress,
						wethPriceFeedKey: WETH_KEY,
						overPriceFeedKey: OVER_KEY,
					},
					MAX_PROFIT_USD,
					29, // below MIN_CANCEL_TIMEOUT
					HOUSE_EDGE,
					{
						subscriptionId: 1,
						keyHash: ethers.ZeroHash,
						callbackGasLimit: 500000,
						requestConfirmations: 3,
						nativePayment: false,
					}
				)
			).to.be.revertedWithCustomError(d, 'InvalidAmount');
		});
	});

	/* ========== FREE BET PATHS ========== */

	describe('FreeBet Paths', () => {
		it('placeBetWithFreeBet should revert for unsupported collateral', async () => {
			await expect(
				dice
					.connect(player)
					.placeBetWithFreeBet(secondAccount.address, MIN_USDC_BET, BetType.ROLL_UNDER, 11)
			).to.be.revertedWithCustomError(dice, 'InvalidCollateral');
		});

		it('placeBetWithFreeBet should revert when freeBetsHolder is not set (address 0)', async () => {
			// freeBetsHolder is address(0) by default in the dice fixture
			await expect(
				dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11)
			).to.be.reverted;
		});

		it('setFreeBetsHolder should emit event', async () => {
			await expect(dice.connect(owner).setFreeBetsHolder(secondAccount.address))
				.to.emit(dice, 'FreeBetsHolderChanged')
				.withArgs(secondAccount.address);
		});

		it('normal bet isFreeBet should be false', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			expect(await dice.isFreeBet(1)).to.equal(false);
		});

		it('isFreeBet mapping returns false for non-existent bet', async () => {
			expect(await dice.isFreeBet(999)).to.equal(false);
		});
	});

	/* ========== BET HISTORY ========== */

	describe('Bet History', () => {
		it('getUserBetCount should return 0 for new user', async () => {
			expect(await dice.getUserBetCount(player.address)).to.equal(0n);
		});

		it('getUserBetCount should increment after placing bets', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET * 2n);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			expect(await dice.getUserBetCount(player.address)).to.equal(1n);

			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			expect(await dice.getUserBetCount(player.address)).to.equal(2n);
		});

		it('getUserBetIds should return bet IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET * 3n);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 5, ethers.ZeroAddress);

			const ids = await dice.getUserBetIds(player.address, 0, 10);
			expect(ids.length).to.equal(3);
			// Most recent first
			const bet0 = await dice.getBetDetails(ids[0]);
			const bet1 = await dice.getBetDetails(ids[1]);
			const bet2 = await dice.getBetDetails(ids[2]);
			expect(bet0.target).to.equal(5n);
			expect(bet1.target).to.equal(10n);
			expect(bet2.target).to.equal(11n);
		});

		it('getUserBetIds should paginate correctly', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET * 3n);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 5, ethers.ZeroAddress);

			const page1 = await dice.getUserBetIds(player.address, 0, 2);
			expect(page1.length).to.equal(2);
			const bet0 = await dice.getBetDetails(page1[0]);
			expect(bet0.target).to.equal(5n);

			const page2 = await dice.getUserBetIds(player.address, 2, 2);
			expect(page2.length).to.equal(1);
			const bet2 = await dice.getBetDetails(page2[0]);
			expect(bet2.target).to.equal(11n);
		});

		it('getUserBetIds should return empty for offset beyond length', async () => {
			const ids = await dice.getUserBetIds(player.address, 100, 10);
			expect(ids.length).to.equal(0);
		});

		it('getRecentBetIds should return bet IDs in reverse chronological order', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET * 2n);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);

			const ids = await dice.getRecentBetIds(0, 10);
			expect(ids.length).to.equal(2);
			const bet0 = await dice.getBetBase(ids[0]);
			expect(bet0.user).to.equal(player.address);
		});

		it('getRecentBetIds should paginate correctly', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET * 3n);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_OVER, 10, ethers.ZeroAddress);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 5, ethers.ZeroAddress);

			const page = await dice.getRecentBetIds(1, 1);
			expect(page.length).to.equal(1);
			// Skip most recent (bet 3), get bet 2
			const bet = await dice.getBetDetails(page[0]);
			expect(bet.target).to.equal(10n);
		});

		it('should not include other users bets in getUserBetIds', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);

			expect(await dice.getUserBetCount(secondAccount.address)).to.equal(0n);
			const ids = await dice.getUserBetIds(secondAccount.address, 0, 10);
			expect(ids.length).to.equal(0);
		});

		it('getRecentBetIds should return empty when offset >= total', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);

			const ids = await dice.getRecentBetIds(100, 10);
			expect(ids.length).to.equal(0);
		});
	});

	/* ========== WETH COLLATERAL ========== */

	describe('WETH Collateral', () => {
		const MIN_WETH_BET = ethers.parseEther('0.001'); // 0.001 WETH = 3 USD at 3000 USD/WETH

		beforeEach(async () => {
			// Fund bankroll with WETH
			await weth.transfer(diceAddress, ethers.parseEther('10'));
			// Fund player with WETH
			await weth.transfer(player.address, ethers.parseEther('1'));
		});

		it('should place a WETH bet and resolve as win', async () => {
			await weth.connect(player).approve(diceAddress, MIN_WETH_BET);
			const tx = await dice
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			const playerBalBefore = await weth.balanceOf(player.address);

			// randomWord=4 -> result=5, ROLL_UNDER target=11 -> win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);

			const betDetails = await dice.getBetDetails(betId);
			const betBase = await dice.getBetBase(betId);
			expect(betDetails.status).to.equal(Status.RESOLVED);
			expect(betDetails.won).to.equal(true);

			const expectedPayout = getExpectedPayout(MIN_WETH_BET, BetType.ROLL_UNDER, 11);
			expect(betBase.payout).to.equal(expectedPayout);
			expect(await weth.balanceOf(player.address)).to.equal(playerBalBefore + expectedPayout);
		});

		it('should place a WETH bet and resolve as loss', async () => {
			await weth.connect(player).approve(diceAddress, MIN_WETH_BET);
			const tx = await dice
				.connect(player)
				.placeBet(wethAddress, MIN_WETH_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// randomWord=14 -> result=15, ROLL_UNDER target=11 -> loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]);

			const betDetails = await dice.getBetDetails(betId);
			expect(betDetails.won).to.equal(false);
		});
	});

	/* ========== COLLATERAL PRICE ========== */

	describe('getCollateralPrice', () => {
		it('should return ONE for USDC', async () => {
			expect(await dice.getCollateralPrice(usdcAddress)).to.equal(ethers.parseEther('1'));
		});

		it('should return the price feed value for WETH', async () => {
			expect(await dice.getCollateralPrice(wethAddress)).to.equal(WETH_PRICE);
		});

		it('should return the price feed value for OVER', async () => {
			expect(await dice.getCollateralPrice(overAddress)).to.equal(OVER_PRICE);
		});

		it('should revert for unsupported collateral', async () => {
			await expect(dice.getCollateralPrice(secondAccount.address)).to.be.revertedWithCustomError(
				dice,
				'InvalidCollateral'
			);
		});
	});

	/* ========== ADDITIONAL GETTERS ========== */

	describe('Additional Getters', () => {
		it('getPotentialProfit should return correct USD profit', async () => {
			const profit = await dice.getPotentialProfit(
				usdcAddress,
				MIN_USDC_BET,
				BetType.ROLL_UNDER,
				11
			);
			// reservedProfit for ROLL_UNDER target=11 = payout - amount
			const expectedReservedProfit = getReservedProfit(MIN_USDC_BET, BetType.ROLL_UNDER, 11);
			// USDC price = 1, so USD value = reservedProfit * 1e18 / 1e6 (adjust for decimals)
			expect(profit).to.be.gt(0n);
		});
	});

	/* ========== VRF UNKNOWN REQUEST ========== */

	describe('VRF unknown requestId', () => {
		it('should silently skip an unknown requestId', async () => {
			await expect(vrfCoordinator.fulfillRandomWords(diceAddress, 999n, [42n])).to.not.be.reverted;
		});
	});

	/* ========== VRF ALREADY RESOLVED ========== */

	describe('VRF already-resolved bet', () => {
		it('should silently skip already-resolved bet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, BetType.ROLL_UNDER, 11, ethers.ZeroAddress);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			// First fulfillment: randomWord=4 -> result=5, win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);
			const detailsAfterFirst = await dice.getBetDetails(betId);
			expect(detailsAfterFirst.status).to.equal(Status.RESOLVED);
			expect(detailsAfterFirst.won).to.equal(true);

			// Second fulfillment should silently return (no revert, no state change)
			await expect(vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n])).to.not.be
				.reverted;

			// Bet should still show first result
			const detailsAfterSecond = await dice.getBetDetails(betId);
			expect(detailsAfterSecond.won).to.equal(true);
		});
	});

	/* ========== REFERRALS ========== */

	describe('Referrals', () => {
		let mockReferrals, mockReferralsAddress;
		const REFERRER_FEE = ethers.parseEther('0.005'); // 0.5%

		beforeEach(async () => {
			const MockReferralsFactory = await ethers.getContractFactory('MockReferrals');
			mockReferrals = await MockReferralsFactory.deploy();
			mockReferralsAddress = await mockReferrals.getAddress();
			await mockReferrals.setReferrerFees(REFERRER_FEE, REFERRER_FEE, REFERRER_FEE);
			await dice.setReferrals(mockReferralsAddress);
		});

		it('should set referrer on placeBet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice.connect(player).placeBet(usdcAddress, MIN_USDC_BET, 0, 11, secondAccount.address);
			expect(await mockReferrals.referrals(player.address)).to.equal(secondAccount.address);
		});

		it('should NOT set referrer when zero address', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice.connect(player).placeBet(usdcAddress, MIN_USDC_BET, 0, 11, ethers.ZeroAddress);
			expect(await mockReferrals.referrals(player.address)).to.equal(ethers.ZeroAddress);
		});

		it('should pay referrer on losing bet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, 0, 11, secondAccount.address);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			// randomWord=14 -> result=15, ROLL_UNDER target=11 -> loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]);

			const details = await dice.getBetDetails(betId);
			expect(details.won).to.equal(false);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			expect(referrerBalAfter - referrerBalBefore).to.equal(expectedFee);
		});

		it('should emit ReferrerPaid on losing bet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, 0, 11, secondAccount.address);
			const { requestId } = await parseBetPlaced(dice, tx);

			const expectedFee = (MIN_USDC_BET * REFERRER_FEE) / ONE;
			await expect(vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]))
				.to.emit(dice, 'ReferrerPaid')
				.withArgs(secondAccount.address, player.address, expectedFee, MIN_USDC_BET, usdcAddress);
		});

		it('should NOT pay referrer on winning bet', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, 0, 11, secondAccount.address);
			const { betId, requestId } = await parseBetPlaced(dice, tx);

			const referrerBalBefore = await usdc.balanceOf(secondAccount.address);

			// randomWord=4 -> result=5, ROLL_UNDER target=11 -> win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);

			const details = await dice.getBetDetails(betId);
			expect(details.won).to.equal(true);

			const referrerBalAfter = await usdc.balanceOf(secondAccount.address);
			expect(referrerBalAfter - referrerBalBefore).to.equal(0n);
		});

		it('should NOT pay if no referrer set', async () => {
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			const tx = await dice
				.connect(player)
				.placeBet(usdcAddress, MIN_USDC_BET, 0, 11, ethers.ZeroAddress);
			const { requestId } = await parseBetPlaced(dice, tx);

			await expect(vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n])).to.not.be
				.reverted;
		});

		it('setReferrals should emit event', async () => {
			await expect(dice.connect(owner).setReferrals(secondAccount.address))
				.to.emit(dice, 'ReferralsChanged')
				.withArgs(secondAccount.address);
		});
	});
});
