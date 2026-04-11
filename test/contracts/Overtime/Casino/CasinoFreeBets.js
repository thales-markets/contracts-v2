const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');
const WETH_PRICE = ethers.parseEther('3000');
const OVER_PRICE = ethers.parseEther('1');

const MAX_PROFIT_USD = ethers.parseEther('1000');
const CANCEL_TIMEOUT = 60n;
const HOUSE_EDGE = ethers.parseEther('0.02');
const ONE = ethers.parseEther('1');
const MIN_USDC_BET = 3n * 1_000_000n;
const EXPIRATION_PERIOD = 86400n; // 1 day

async function deployFixture() {
	const [owner, funder, player, secondAccount, resolver] = await ethers.getSigners();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await ExoticUSDC.deploy();
	const usdcAddress = await usdc.getAddress();
	// Top up owner with more USDC for funding multiple casino bankrolls
	await usdc.mintForUser(owner.address);
	await usdc.mintForUser(owner.address);

	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const weth = await ExoticUSD.deploy();
	const over = await ExoticUSD.deploy();
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

	const MockVRFCoordinator = await ethers.getContractFactory('MockVRFCoordinator');
	const vrfCoordinator = await MockVRFCoordinator.deploy();
	const vrfCoordinatorAddress = await vrfCoordinator.getAddress();

	const core = {
		owner: owner.address,
		manager: managerAddress,
		priceFeed: priceFeedAddress,
		vrfCoordinator: vrfCoordinatorAddress,
	};
	const collateralConfig = {
		usdc: usdcAddress,
		weth: wethAddress,
		over: overAddress,
		wethPriceFeedKey: WETH_KEY,
		overPriceFeedKey: OVER_KEY,
	};
	const vrfConfig = {
		subscriptionId: 1,
		keyHash: ethers.ZeroHash,
		callbackGasLimit: 500000,
		requestConfirmations: 3,
		nativePayment: false,
	};

	// Deploy FreeBetsHolder (shared sports + casino)
	const HolderFactory = await ethers.getContractFactory('FreeBetsHolder');
	const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
	await holder.initialize(owner.address, owner.address, owner.address);
	const holderAddress = await holder.getAddress();

	// Configure holder for casino
	await holder.addSupportedCollateral(usdcAddress, true, owner.address);
	await holder.setFreeBetExpirationPeriod(EXPIRATION_PERIOD, Math.floor(Date.now() / 1000));

	// Deploy Dice
	const DiceFactory = await ethers.getContractFactory('Dice');
	const dice = await upgrades.deployProxy(DiceFactory, [], { initializer: false });
	await dice.initialize(
		core,
		collateralConfig,
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		HOUSE_EDGE,
		vrfConfig
	);
	const diceAddress = await dice.getAddress();
	await dice.setFreeBetsHolder(holderAddress);

	// Deploy Slots
	const SlotsFactory = await ethers.getContractFactory('Slots');
	const slots = await upgrades.deployProxy(SlotsFactory, [], { initializer: false });
	await slots.initialize(
		core,
		collateralConfig,
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		HOUSE_EDGE,
		ethers.parseEther('5'),
		vrfConfig
	);
	const slotsAddress = await slots.getAddress();
	await slots.setFreeBetsHolder(holderAddress);
	await slots.setSymbols(5, [20, 20, 20, 20, 20]);
	for (let i = 0; i < 5; i++) await slots.setTriplePayout(i, ethers.parseEther('5'));

	// Deploy Baccarat
	const BaccaratFactory = await ethers.getContractFactory('Baccarat');
	const baccarat = await upgrades.deployProxy(BaccaratFactory, [], { initializer: false });
	await baccarat.initialize(
		core,
		collateralConfig,
		MAX_PROFIT_USD,
		CANCEL_TIMEOUT,
		0, // use default banker payout
		vrfConfig
	);
	const baccaratAddress = await baccarat.getAddress();
	await baccarat.setFreeBetsHolder(holderAddress);

	// Deploy Blackjack
	const BlackjackFactory = await ethers.getContractFactory('Blackjack');
	const blackjack = await upgrades.deployProxy(BlackjackFactory, [], { initializer: false });
	await blackjack.initialize(core, collateralConfig, MAX_PROFIT_USD, CANCEL_TIMEOUT, vrfConfig);
	const blackjackAddress = await blackjack.getAddress();
	await blackjack.setFreeBetsHolder(holderAddress);

	// Deploy Roulette
	const RouletteFactory = await ethers.getContractFactory('Roulette');
	const roulette = await upgrades.deployProxy(RouletteFactory, [], { initializer: false });
	await roulette.initialize(core, collateralConfig, MAX_PROFIT_USD, CANCEL_TIMEOUT, vrfConfig);
	const rouletteAddress = await roulette.getAddress();
	await roulette.setFreeBetsHolder(holderAddress);

	// Whitelist casino contracts in holder
	await holder.setWhitelistedCasino(diceAddress, true);
	await holder.setWhitelistedCasino(slotsAddress, true);
	await holder.setWhitelistedCasino(baccaratAddress, true);
	await holder.setWhitelistedCasino(blackjackAddress, true);
	await holder.setWhitelistedCasino(rouletteAddress, true);

	// Fund bankrolls
	await usdc.transfer(diceAddress, 30n * 1_000_000n);
	await usdc.transfer(slotsAddress, 30n * 1_000_000n);
	await usdc.transfer(baccaratAddress, 30n * 1_000_000n);
	await usdc.transfer(blackjackAddress, 30n * 1_000_000n);
	await usdc.transfer(rouletteAddress, 30n * 1_000_000n);

	// Fund funder with USDC for free bets
	await usdc.transfer(funder.address, 20n * 1_000_000n);

	return {
		holder,
		holderAddress,
		dice,
		diceAddress,
		slots,
		slotsAddress,
		baccarat,
		baccaratAddress,
		blackjack,
		blackjackAddress,
		roulette,
		rouletteAddress,
		usdc,
		usdcAddress,
		vrfCoordinator,
		owner,
		funder,
		player,
		secondAccount,
		resolver,
	};
}

describe('CasinoFreeBets', () => {
	let holder, holderAddress, dice, diceAddress, slots, slotsAddress;
	let baccarat, baccaratAddress, blackjack, blackjackAddress, roulette, rouletteAddress;
	let usdc, usdcAddress, vrfCoordinator;
	let owner, funder, player, secondAccount;

	beforeEach(async () => {
		({
			holder,
			holderAddress,
			dice,
			diceAddress,
			slots,
			slotsAddress,
			baccarat,
			baccaratAddress,
			blackjack,
			blackjackAddress,
			roulette,
			rouletteAddress,
			usdc,
			usdcAddress,
			vrfCoordinator,
			owner,
			funder,
			player,
			secondAccount,
		} = await loadFixture(deployFixture));
	});

	describe('Holder: Casino Whitelist', () => {
		it('should whitelist casino contract', async () => {
			expect(await holder.whitelistedCasino(diceAddress)).to.equal(true);
		});

		it('should revert setWhitelistedCasino for non-owner', async () => {
			await expect(holder.connect(secondAccount).setWhitelistedCasino(diceAddress, false)).to.be
				.reverted;
		});

		it('should revert setWhitelistedCasino with zero address', async () => {
			await expect(
				holder.connect(owner).setWhitelistedCasino(ethers.ZeroAddress, true)
			).to.be.revertedWithCustomError(holder, 'InvalidAddress');
		});

		it('should revert useFreeBet from non-whitelisted', async () => {
			await expect(
				holder.connect(secondAccount).useFreeBet(player.address, usdcAddress, MIN_USDC_BET)
			).to.be.revertedWithCustomError(holder, 'CallerNotAllowed');
		});
	});

	describe('Holder: Fund and Use', () => {
		it('should fund a user and deduct on casino use', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(
				MIN_USDC_BET
			);
		});
	});

	describe('Dice: Free Bet', () => {
		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should place a free bet', async () => {
			const tx = await dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, 0, 11);
			await expect(tx).to.emit(dice, 'BetPlaced');
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
			expect(await dice.isFreeBet(1)).to.equal(true);
		});

		it('should send only profit to user on free bet win', async () => {
			const tx = await dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, 0, 11);
			const receipt = await tx.wait();
			const betEvent = receipt.logs
				.map((l) => {
					try {
						return dice.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const requestId = betEvent.args.requestId;

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);

			// Win: randomWord=4 → result=5, ROLL_UNDER target=11 → win
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [4n]);

			const betDetails = await dice.getBetDetails(1);
			expect(betDetails.won).to.equal(true);

			const betBase = await dice.getBetBase(1);
			const profit = betBase.payout - MIN_USDC_BET;
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore + profit);
			expect(await usdc.balanceOf(holderAddress)).to.equal(holderBalBefore + MIN_USDC_BET);
		});

		it('should not send anything on free bet loss', async () => {
			const tx = await dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, 0, 11);
			const receipt = await tx.wait();
			const betEvent = receipt.logs
				.map((l) => {
					try {
						return dice.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const requestId = betEvent.args.requestId;

			const playerBalBefore = await usdc.balanceOf(player.address);

			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]);

			const betDetails = await dice.getBetDetails(1);
			expect(betDetails.won).to.equal(false);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);
		});

		it('should revert free bet with insufficient balance', async () => {
			await expect(
				dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET * 2n, 0, 11)
			).to.be.revertedWithCustomError(holder, 'InsufficientBalance');
		});

		it('normal bet should not be flagged as free bet', async () => {
			await usdc.transfer(player.address, MIN_USDC_BET);
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice.connect(player).placeBet(usdcAddress, MIN_USDC_BET, 0, 11, ethers.ZeroAddress);
			expect(await dice.isFreeBet(1)).to.equal(false);
		});
	});

	describe('Slots: Free Bet', () => {
		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should place a free spin', async () => {
			await slots.connect(player).spinWithFreeBet(usdcAddress, MIN_USDC_BET);
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
			expect(await slots.isFreeBet(1)).to.equal(true);
		});
	});

	describe('Dice: Free Bet Cancel', () => {
		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should return stake to holder on cancel, user gets nothing', async () => {
			const tx = await dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, 0, 11);
			const receipt = await tx.wait();
			const betEvent = receipt.logs
				.map((l) => {
					try {
						return dice.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = betEvent.args.betId;

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);

			await time.increase(CANCEL_TIMEOUT);
			await dice.connect(player).cancelBet(betId);

			const betDetails = await dice.getBetDetails(betId);
			expect(betDetails.status).to.equal(3n); // CANCELLED

			// Stake returned to holder, not user
			expect(await usdc.balanceOf(holderAddress)).to.equal(holderBalBefore + MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);

			// User freebet balance NOT restored
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});
	});

	describe('Slots: Free Bet Cancel', () => {
		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should return stake to holder on cancel, user gets nothing', async () => {
			const tx = await slots.connect(player).spinWithFreeBet(usdcAddress, MIN_USDC_BET);
			const receipt = await tx.wait();
			const spinEvent = receipt.logs
				.map((l) => {
					try {
						return slots.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'SpinPlaced');
			const spinId = spinEvent.args.spinId;

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);

			await time.increase(CANCEL_TIMEOUT);
			await slots.connect(player).cancelSpin(spinId);

			const spinDetails = await slots.getSpinDetails(spinId);
			expect(spinDetails.status).to.equal(3n); // CANCELLED

			// Stake returned to holder, not user
			expect(await usdc.balanceOf(holderAddress)).to.equal(holderBalBefore + MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);

			// User freebet balance NOT restored
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});
	});

	describe('Baccarat: Free Bet Cancel', () => {
		// Baccarat BetType.PLAYER = 0
		const PLAYER_BET = 0;

		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should return stake to holder on cancel, user gets nothing', async () => {
			const tx = await baccarat
				.connect(player)
				.placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, PLAYER_BET);
			const receipt = await tx.wait();
			const betEvent = receipt.logs
				.map((l) => {
					try {
						return baccarat.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = betEvent.args.betId;

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);

			await time.increase(CANCEL_TIMEOUT);
			await baccarat.connect(player).cancelBet(betId);

			const betDetails = await baccarat.getBetDetails(betId);
			expect(betDetails.status).to.equal(3n); // CANCELLED

			// Stake returned to holder, not user
			expect(await usdc.balanceOf(holderAddress)).to.equal(holderBalBefore + MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);

			// User freebet balance NOT restored
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});
	});

	describe('Blackjack: Free Bet Cancel', () => {
		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should return stake to holder on cancel, user gets nothing', async () => {
			const tx = await blackjack.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET);
			const receipt = await tx.wait();
			const handEvent = receipt.logs
				.map((l) => {
					try {
						return blackjack.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'HandCreated');
			const handId = handEvent.args.handId;

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);

			await time.increase(CANCEL_TIMEOUT);
			await blackjack.connect(player).cancelHand(handId);

			const handDetails = await blackjack.getHandDetails(handId);
			expect(handDetails.status).to.equal(7n); // CANCELLED (Blackjack enum)

			expect(await usdc.balanceOf(holderAddress)).to.equal(holderBalBefore + MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);

			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});
	});

	describe('Roulette: Free Bet Cancel', () => {
		// Roulette BetType.RED_BLACK = 1
		const RED_BLACK = 1;

		beforeEach(async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
		});

		it('should return stake to holder on cancel, user gets nothing', async () => {
			const tx = await roulette
				.connect(player)
				.placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, RED_BLACK, 0);
			const receipt = await tx.wait();
			const betEvent = receipt.logs
				.map((l) => {
					try {
						return roulette.interface.parseLog(l);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'BetPlaced');
			const betId = betEvent.args.betId;

			const playerBalBefore = await usdc.balanceOf(player.address);
			const holderBalBefore = await usdc.balanceOf(holderAddress);

			await time.increase(CANCEL_TIMEOUT);
			await roulette.connect(player).cancelBet(betId);

			const betDetails = await roulette.getBetDetails(betId);
			expect(betDetails.status).to.equal(3n); // CANCELLED

			expect(await usdc.balanceOf(holderAddress)).to.equal(holderBalBefore + MIN_USDC_BET);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);

			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});
	});
});
