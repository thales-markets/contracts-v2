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
const BANKER_PAYOUT = ethers.parseEther('1.95'); // 1.95x
const ONE = ethers.parseEther('1');

const MIN_USDC_BET = 3n * 1_000_000n;

// BetType enum
const BetType = { PLAYER: 0n, BANKER: 1n, TIE: 2n };

// BetStatus enum
const Status = { NONE: 0n, PENDING: 1n, RESOLVED: 2n, CANCELLED: 3n };

// GameResult enum
const GameResult = { PLAYER: 0n, BANKER: 1n, TIE: 2n };

// Card derivation helpers matching contract logic
function getCardRank(randomWord, index) {
	const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
		['uint256', 'uint256'],
		[randomWord, index]
	);
	const hash = BigInt(ethers.keccak256(encoded));
	return Number((hash % 13n) + 1n);
}

function baccaratValue(rank) {
	if (rank === 1) return 1;
	if (rank >= 2 && rank <= 9) return rank;
	return 0;
}

function getCardValue(word, idx) {
	return baccaratValue(getCardRank(word, idx));
}

function handTotal(c1, c2) {
	return (c1 + c2) % 10;
}

function handTotal3(c1, c2, c3) {
	return (c1 + c2 + c3) % 10;
}

function shouldPlayerDraw(t) {
	return t <= 5;
}

function shouldBankerDraw(bt, playerDrew, p3) {
	if (!playerDrew) return bt <= 5;
	if (bt <= 2) return true;
	if (bt === 3) return p3 !== 8;
	if (bt === 4) return p3 >= 2 && p3 <= 7;
	if (bt === 5) return p3 >= 4 && p3 <= 7;
	if (bt === 6) return p3 === 6 || p3 === 7;
	return false;
}

// Simulate full game from a random word
function simulateGame(word) {
	const p1 = getCardValue(word, 0);
	const b1 = getCardValue(word, 1);
	const p2 = getCardValue(word, 2);
	const b2 = getCardValue(word, 3);

	let pt = handTotal(p1, p2);
	let bt = handTotal(b1, b2);

	const pNat = pt === 8 || pt === 9;
	const bNat = bt === 8 || bt === 9;

	let pdrew = false;
	let p3 = 0;

	if (!pNat && !bNat) {
		pdrew = shouldPlayerDraw(pt);
		if (pdrew) {
			p3 = getCardValue(word, 4);
			pt = handTotal3(p1, p2, p3);
		}
		if (shouldBankerDraw(bt, pdrew, p3)) {
			const b3 = getCardValue(word, 5);
			bt = handTotal3(b1, b2, b3);
		}
	}

	let result;
	if (pt > bt) result = 'PLAYER';
	else if (bt > pt) result = 'BANKER';
	else result = 'TIE';

	return { playerTotal: pt, bankerTotal: bt, result };
}

// Find a VRF word that produces a given game result
function findWord(targetResult, startFrom = 0n) {
	for (let w = startFrom; w < startFrom + 200n; w++) {
		const sim = simulateGame(w);
		if (sim.result === targetResult) return { word: w, ...sim };
	}
	throw new Error(`Could not find word for ${targetResult}`);
}

async function deployBaccaratFixture() {
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

	const BaccaratFactory = await ethers.getContractFactory('Baccarat');
	const baccarat = await upgrades.deployProxy(BaccaratFactory, [], { initializer: false });
	const baccaratAddress = await baccarat.getAddress();

	await baccarat.initialize(
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
		0, // use DEFAULT_BANKER_PAYOUT
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);

	// Fund bankroll
	await usdc.transfer(baccaratAddress, 50n * 1_000_000n);

	// Fund player
	await usdc.transfer(player.address, 40n * 1_000_000n);

	return {
		baccarat,
		baccaratAddress,
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

async function getBet(baccarat, betId) {
	const base = await baccarat.getBetBase(betId);
	const details = await baccarat.getBetDetails(betId);
	return {
		user: base.user,
		collateral: base.collateral,
		amount: base.amount,
		payout: base.payout,
		requestId: base.requestId,
		placedAt: base.placedAt,
		resolvedAt: base.resolvedAt,
		reservedProfit: base.reservedProfit,
		betType: details.betType,
		status: details.status,
		result: details.result,
		won: details.won,
		isPush: details.isPush,
		cards: details.cards,
		playerTotal: details.playerTotal,
		bankerTotal: details.bankerTotal,
	};
}

async function parseBetPlaced(baccarat, tx) {
	const receipt = await tx.wait();
	const parsed = receipt.logs
		.map((log) => {
			try {
				return baccarat.interface.parseLog(log);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'BetPlaced');
	return { betId: parsed.args.betId, requestId: parsed.args.requestId };
}

describe('Baccarat', () => {
	let baccarat, baccaratAddress, usdc, usdcAddress, vrfCoordinator;
	let owner, secondAccount, resolver, riskManager, pauser, player;

	// Pre-compute test words
	const playerWinWord = findWord('PLAYER');
	const bankerWinWord = findWord('BANKER');
	const tieWord = findWord('TIE');

	beforeEach(async () => {
		({
			baccarat,
			baccaratAddress,
			usdc,
			usdcAddress,
			vrfCoordinator,
			owner,
			secondAccount,
			resolver,
			riskManager,
			pauser,
			player,
		} = await loadFixture(deployBaccaratFixture));
	});

	/* ========== INITIALIZATION ========== */

	describe('Initialization', () => {
		it('should set correct state after initialize', async () => {
			expect(await baccarat.owner()).to.equal(owner.address);
			expect(await baccarat.usdc()).to.equal(usdcAddress);
			expect(await baccarat.maxProfitUsd()).to.equal(MAX_PROFIT_USD);
			expect(await baccarat.cancelTimeout()).to.equal(CANCEL_TIMEOUT);
			expect(await baccarat.bankerPayoutMultiplier()).to.equal(BANKER_PAYOUT);
			expect(await baccarat.nextBetId()).to.equal(1n);
		});

		it('should revert on re-initialization', async () => {
			await expect(
				baccarat.initialize(
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
			).to.be.reverted;
		});
	});

	/* ========== PLACE BET ========== */

	describe('placeBet', () => {
		it('should revert for unsupported collateral', async () => {
			await expect(
				baccarat.connect(player).placeBet(secondAccount.address, MIN_USDC_BET, BetType.PLAYER)
			).to.be.revertedWithCustomError(baccarat, 'InvalidCollateral');
		});

		it('should revert for zero amount', async () => {
			await expect(
				baccarat.connect(player).placeBet(usdcAddress, 0, BetType.PLAYER)
			).to.be.revertedWithCustomError(baccarat, 'InvalidAmount');
		});

		it('should revert when paused', async () => {
			await baccarat.connect(pauser).setPausedByRole(true);
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			await expect(baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER)).to
				.be.reverted;
		});

		it('should place a PLAYER bet and emit BetPlaced', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			await expect(
				baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER)
			).to.emit(baccarat, 'BetPlaced');

			const bet = await getBet(baccarat, 1n);
			expect(bet.user).to.equal(player.address);
			expect(bet.status).to.equal(Status.PENDING);
			expect(bet.betType).to.equal(BetType.PLAYER);
			expect(await baccarat.nextBetId()).to.equal(2n);
		});

		it('should place a BANKER bet', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.BANKER);
			const { betId } = await parseBetPlaced(baccarat, tx);

			const bet = await getBet(baccarat, betId);
			expect(bet.betType).to.equal(BetType.BANKER);
		});

		it('should place a TIE bet', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.TIE);
			const { betId } = await parseBetPlaced(baccarat, tx);

			const bet = await getBet(baccarat, betId);
			expect(bet.betType).to.equal(BetType.TIE);
		});
	});

	/* ========== RESOLUTION ========== */

	describe('Resolution', () => {
		it('should resolve PLAYER bet as win when player wins', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			const balBefore = await usdc.balanceOf(player.address);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [playerWinWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.status).to.equal(Status.RESOLVED);
			expect(bet.result).to.equal(GameResult.PLAYER);
			expect(bet.won).to.equal(true);
			expect(bet.isPush).to.equal(false);
			expect(bet.payout).to.equal(MIN_USDC_BET * 2n); // 2x
			expect(bet.playerTotal).to.equal(BigInt(playerWinWord.playerTotal));
			expect(bet.bankerTotal).to.equal(BigInt(playerWinWord.bankerTotal));
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET * 2n);
		});

		it('should resolve PLAYER bet as loss when banker wins', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [bankerWinWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.result).to.equal(GameResult.BANKER);
			expect(bet.won).to.equal(false);
			expect(bet.isPush).to.equal(false);
			expect(bet.payout).to.equal(0n);
		});

		it('should push PLAYER bet on tie (refund)', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			const balBefore = await usdc.balanceOf(player.address);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [tieWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.result).to.equal(GameResult.TIE);
			expect(bet.won).to.equal(false);
			expect(bet.isPush).to.equal(true);
			expect(bet.payout).to.equal(MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
		});

		it('should resolve BANKER bet as win with 1.95x payout', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.BANKER);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			const balBefore = await usdc.balanceOf(player.address);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [bankerWinWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.result).to.equal(GameResult.BANKER);
			expect(bet.won).to.equal(true);
			const expectedPayout = (MIN_USDC_BET * BANKER_PAYOUT) / ONE;
			expect(bet.payout).to.equal(expectedPayout);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + expectedPayout);
		});

		it('should push BANKER bet on tie (refund)', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.BANKER);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			const balBefore = await usdc.balanceOf(player.address);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [tieWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.isPush).to.equal(true);
			expect(bet.payout).to.equal(MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
		});

		it('should resolve TIE bet as win with 9x payout', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.TIE);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			const balBefore = await usdc.balanceOf(player.address);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [tieWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.result).to.equal(GameResult.TIE);
			expect(bet.won).to.equal(true);
			expect(bet.payout).to.equal(MIN_USDC_BET * 9n); // 9x
			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET * 9n);
		});

		it('should resolve TIE bet as loss when player wins', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.TIE);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [playerWinWord.word]);

			const bet = await getBet(baccarat, betId);
			expect(bet.won).to.equal(false);
			expect(bet.isPush).to.equal(false);
			expect(bet.payout).to.equal(0n);
		});
	});

	/* ========== CANCEL ========== */

	describe('cancelBet', () => {
		it('should revert if timeout not reached', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId } = await parseBetPlaced(baccarat, tx);

			await expect(baccarat.connect(player).cancelBet(betId)).to.be.revertedWithCustomError(
				baccarat,
				'CancelTimeoutNotReached'
			);
		});

		it('should cancel after timeout and refund', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId } = await parseBetPlaced(baccarat, tx);

			const balBefore = await usdc.balanceOf(player.address);
			await time.increase(CANCEL_TIMEOUT);

			await expect(baccarat.connect(player).cancelBet(betId)).to.emit(baccarat, 'BetCancelled');

			expect(await usdc.balanceOf(player.address)).to.equal(balBefore + MIN_USDC_BET);
			const bet = await getBet(baccarat, betId);
			expect(bet.status).to.equal(Status.CANCELLED);
		});
	});

	/* ========== ADMIN CANCEL ========== */

	describe('adminCancelBet', () => {
		it('should revert for non-resolver', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId } = await parseBetPlaced(baccarat, tx);

			await expect(
				baccarat.connect(secondAccount).adminCancelBet(betId)
			).to.be.revertedWithCustomError(baccarat, 'InvalidSender');
		});

		it('should allow owner to admin cancel', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId } = await parseBetPlaced(baccarat, tx);

			await expect(baccarat.connect(owner).adminCancelBet(betId)).to.emit(baccarat, 'BetCancelled');
		});
	});

	/* ========== WITHDRAW COLLATERAL ========== */

	describe('withdrawCollateral', () => {
		it('should allow owner to withdraw', async () => {
			const amount = 10n * 1_000_000n;
			await expect(
				baccarat.connect(owner).withdrawCollateral(usdcAddress, secondAccount.address, amount)
			)
				.to.emit(baccarat, 'WithdrawnCollateral')
				.withArgs(usdcAddress, secondAccount.address, amount);
		});

		it('should revert for non-owner', async () => {
			await expect(
				baccarat.connect(secondAccount).withdrawCollateral(usdcAddress, secondAccount.address, 1n)
			).to.be.reverted;
		});
	});

	/* ========== GETTERS ========== */

	describe('Getters', () => {
		it('getPotentialPayoutCollateral PLAYER should return 2x', async () => {
			expect(await baccarat.getPotentialPayoutCollateral(MIN_USDC_BET, BetType.PLAYER)).to.equal(
				MIN_USDC_BET * 2n
			);
		});

		it('getPotentialPayoutCollateral BANKER should return 1.95x', async () => {
			const expected = (MIN_USDC_BET * BANKER_PAYOUT) / ONE;
			expect(await baccarat.getPotentialPayoutCollateral(MIN_USDC_BET, BetType.BANKER)).to.equal(
				expected
			);
		});

		it('getPotentialPayoutCollateral TIE should return 9x', async () => {
			expect(await baccarat.getPotentialPayoutCollateral(MIN_USDC_BET, BetType.TIE)).to.equal(
				MIN_USDC_BET * 9n
			);
		});

		it('getBaccaratCardValue should return correct values', async () => {
			expect(await baccarat.getBaccaratCardValue(1)).to.equal(1n); // Ace
			expect(await baccarat.getBaccaratCardValue(5)).to.equal(5n);
			expect(await baccarat.getBaccaratCardValue(9)).to.equal(9n);
			expect(await baccarat.getBaccaratCardValue(10)).to.equal(0n); // 10
			expect(await baccarat.getBaccaratCardValue(13)).to.equal(0n); // K
		});

		it('getGameResult should return correct results', async () => {
			expect(await baccarat.getGameResult(9, 5)).to.equal(GameResult.PLAYER);
			expect(await baccarat.getGameResult(3, 7)).to.equal(GameResult.BANKER);
			expect(await baccarat.getGameResult(6, 6)).to.equal(GameResult.TIE);
		});

		it('getAvailableLiquidity should return bankroll minus reserved', async () => {
			expect(await baccarat.getAvailableLiquidity(usdcAddress)).to.equal(50n * 1_000_000n);
		});
	});

	/* ========== SETTERS ========== */

	describe('Setters', () => {
		it('setBankerPayoutMultiplier should update and emit', async () => {
			const newMult = ethers.parseEther('1.90');
			await expect(baccarat.connect(owner).setBankerPayoutMultiplier(newMult))
				.to.emit(baccarat, 'BankerPayoutMultiplierChanged')
				.withArgs(newMult);
			expect(await baccarat.bankerPayoutMultiplier()).to.equal(newMult);
		});

		it('setBankerPayoutMultiplier should revert below MIN', async () => {
			const tooLow = ethers.parseEther('0.5');
			await expect(
				baccarat.connect(owner).setBankerPayoutMultiplier(tooLow)
			).to.be.revertedWithCustomError(baccarat, 'InvalidBankerPayoutMultiplier');
		});

		it('setBankerPayoutMultiplier should revert above MAX', async () => {
			const tooHigh = ethers.parseEther('2.5');
			await expect(
				baccarat.connect(owner).setBankerPayoutMultiplier(tooHigh)
			).to.be.revertedWithCustomError(baccarat, 'InvalidBankerPayoutMultiplier');
		});
	});

	/* ========== VRF AUTH ========== */

	describe('VRF auth', () => {
		it('should revert rawFulfillRandomWords from non-coordinator', async () => {
			await expect(
				baccarat.connect(secondAccount).rawFulfillRandomWords(1n, [7n])
			).to.be.revertedWithCustomError(baccarat, 'InvalidSender');
		});
	});

	/* ========== BET HISTORY ========== */

	describe('Bet History', () => {
		it('getUserBetCount should return 0 for new user', async () => {
			expect(await baccarat.getUserBetCount(player.address)).to.equal(0n);
		});

		it('getUserBetCount should increment after placing bets', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET * 2n);
			await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			expect(await baccarat.getUserBetCount(player.address)).to.equal(1n);

			await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.BANKER);
			expect(await baccarat.getUserBetCount(player.address)).to.equal(2n);
		});

		it('getUserBets should return bets in reverse chronological order', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET * 3n);
			await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.BANKER);
			await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.TIE);

			const views = await baccarat.getUserBets(player.address, 0, 10);
			expect(views.length).to.equal(3);
			expect(views[0].betId).to.equal(3n);
			expect(views[1].betId).to.equal(2n);
			expect(views[2].betId).to.equal(1n);
		});

		it('getUserBets should return empty for offset beyond length', async () => {
			const views = await baccarat.getUserBets(player.address, 100, 10);
			expect(views.length).to.equal(0);
		});

		it('should not include other users bets in getUserBets', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);

			expect(await baccarat.getUserBetCount(secondAccount.address)).to.equal(0n);
		});

		it('getUserBets should return full BetView with cards and totals', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.PLAYER);
			const { betId, requestId } = await parseBetPlaced(baccarat, tx);

			// Resolve
			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [42n]);

			const views = await baccarat.getUserBets(player.address, 0, 10);
			expect(views.length).to.equal(1);
			expect(views[0].betId).to.equal(betId);
			expect(views[0].user).to.equal(player.address);
			expect(views[0].amount).to.equal(MIN_USDC_BET);
			expect(views[0].betType).to.equal(BetType.PLAYER);
			expect(views[0].status).to.equal(Status.RESOLVED);
			// cards array should be populated
			expect(views[0].cards.length).to.equal(6);
		});

		it('getRecentBets should return full BetView', async () => {
			await usdc.connect(player).approve(baccaratAddress, MIN_USDC_BET);
			const tx = await baccarat.connect(player).placeBet(usdcAddress, MIN_USDC_BET, BetType.BANKER);
			const { requestId } = await parseBetPlaced(baccarat, tx);

			await vrfCoordinator.fulfillRandomWords(baccaratAddress, requestId, [100n]);

			const views = await baccarat.getRecentBets(0, 10);
			expect(views.length).to.equal(1);
			expect(views[0].betId).to.equal(1n);
			expect(views[0].collateral).to.equal(usdcAddress);
		});

		it('getUserBets should return empty for offset beyond length', async () => {
			const views = await baccarat.getUserBets(player.address, 100, 10);
			expect(views.length).to.equal(0);
		});
	});
});
