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

	// Deploy CasinoFreeBetsHolder
	const HolderFactory = await ethers.getContractFactory('CasinoFreeBetsHolder');
	const holder = await upgrades.deployProxy(HolderFactory, [], { initializer: false });
	await holder.initialize(owner.address, EXPIRATION_PERIOD);
	const holderAddress = await holder.getAddress();

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

	// Whitelist casino contracts in holder
	await holder.setWhitelistedCasino(diceAddress, true);
	await holder.setWhitelistedCasino(slotsAddress, true);

	// Fund bankrolls
	await usdc.transfer(diceAddress, 30n * 1_000_000n);
	await usdc.transfer(slotsAddress, 30n * 1_000_000n);

	// Fund funder with USDC for free bets
	await usdc.transfer(funder.address, 20n * 1_000_000n);

	return {
		holder,
		holderAddress,
		dice,
		diceAddress,
		slots,
		slotsAddress,
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
			usdc,
			usdcAddress,
			vrfCoordinator,
			owner,
			funder,
			player,
			secondAccount,
		} = await loadFixture(deployFixture));
	});

	describe('Holder: Funding', () => {
		it('should fund a user', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await expect(holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET)).to.emit(
				holder,
				'UserFunded'
			);
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(
				MIN_USDC_BET
			);
		});

		it('should set expiration on first fund', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
			const expiry = await holder.expirationPerUserAndCollateral(player.address, usdcAddress);
			expect(expiry).to.be.gt(0n);
		});

		it('should fund batch', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET * 2n);
			await holder
				.connect(funder)
				.fundBatch([player.address, secondAccount.address], usdcAddress, MIN_USDC_BET);
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(
				MIN_USDC_BET
			);
			expect(await holder.balancePerUserAndCollateral(secondAccount.address, usdcAddress)).to.equal(
				MIN_USDC_BET
			);
		});

		it('should allow owner to remove funding', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);
			await holder.connect(owner).removeUserFunding(player.address, usdcAddress);
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});
	});

	describe('Holder: Whitelist', () => {
		it('should revert useFreeBet from non-whitelisted', async () => {
			await expect(
				holder.connect(secondAccount).useFreeBet(player.address, usdcAddress, MIN_USDC_BET)
			).to.be.revertedWithCustomError(holder, 'InvalidSender');
		});
	});

	describe('Dice: Free Bet', () => {
		beforeEach(async () => {
			// Fund player with 3 USDC free bet
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

			const bet = await dice.bets(1);
			expect(bet.won).to.equal(true);

			// Player gets profit only (payout - amount)
			const playerBalAfter = await usdc.balanceOf(player.address);
			const profit = bet.payout - MIN_USDC_BET;
			expect(playerBalAfter - playerBalBefore).to.equal(profit);

			// Holder gets stake back
			const holderBalAfter = await usdc.balanceOf(holderAddress);
			expect(holderBalAfter - holderBalBefore).to.equal(MIN_USDC_BET);
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

			// Lose: randomWord=14 → result=15, ROLL_UNDER target=11 → loss
			await vrfCoordinator.fulfillRandomWords(diceAddress, requestId, [14n]);

			const bet = await dice.bets(1);
			expect(bet.won).to.equal(false);
			expect(await usdc.balanceOf(player.address)).to.equal(playerBalBefore);
		});

		it('should revert free bet with insufficient balance', async () => {
			// Player already has MIN_USDC_BET, try to bet double
			await expect(
				dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET * 2n, 0, 11)
			).to.be.revertedWithCustomError(holder, 'InsufficientBalance');
		});

		it('should revert free bet after expiry', async () => {
			await time.increase(EXPIRATION_PERIOD + 1n);
			await expect(
				dice.connect(player).placeBetWithFreeBet(usdcAddress, MIN_USDC_BET, 0, 11)
			).to.be.revertedWithCustomError(holder, 'FreeBetExpired');
		});

		it('normal bet should not be flagged as free bet', async () => {
			await usdc.transfer(player.address, MIN_USDC_BET);
			await usdc.connect(player).approve(diceAddress, MIN_USDC_BET);
			await dice.connect(player).placeBet(usdcAddress, MIN_USDC_BET, 0, 11);
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

	describe('Holder: Expiry cleanup', () => {
		it('should allow anyone to remove expired funding', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);

			await time.increase(EXPIRATION_PERIOD + 1n);

			await holder.connect(secondAccount).removeExpiredFunding(player.address, usdcAddress);
			expect(await holder.balancePerUserAndCollateral(player.address, usdcAddress)).to.equal(0n);
		});

		it('should revert if not expired', async () => {
			await usdc.connect(funder).approve(holderAddress, MIN_USDC_BET);
			await holder.connect(funder).fund(player.address, usdcAddress, MIN_USDC_BET);

			await expect(
				holder.connect(secondAccount).removeExpiredFunding(player.address, usdcAddress)
			).to.be.revertedWithCustomError(holder, 'FreeBetExpired');
		});
	});
});
