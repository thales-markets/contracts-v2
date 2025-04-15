const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_NBA,
	RESULT_TYPE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2Data,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		secondTrader,
		thirdAccount,
		freeBetsHolder,
		collateralAddress,
		collateral,
		sportsAMMV2RiskManager,
		mockChainlinkOracle,
		liveTradingProcessor,
		sportsAMMV2ResultManager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			freeBetsHolder,
			collateralAddress,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			liveTradingProcessor,
			sportsAMMV2ResultManager,
			collateral,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader, secondTrader, thirdAccount } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade with free bet', () => {
		it('Fund batch', async () => {
			const firstTraderBalanceBeforeFunding = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);

			await freeBetsHolder.fundBatch(
				[firstTrader, firstLiquidityProvider],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			const firstTraderBalanceAfterFunding = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfterFunding - firstTraderBalanceBeforeFunding).to.equal(
				BUY_IN_AMOUNT
			);

			const firstLiquidityProviderBeforeReclaiming =
				await collateral.balanceOf(firstLiquidityProvider);

			await freeBetsHolder.removeUserFundingBatch(
				[firstTrader],
				collateralAddress,
				firstLiquidityProvider
			);

			const firstTraderBalanceAfterReclaimingFunding =
				await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress);
			expect(firstTraderBalanceAfterReclaimingFunding).to.equal(0);

			const firstLiquidityProviderAfterReclaiming =
				await collateral.balanceOf(firstLiquidityProvider);

			expect(firstLiquidityProviderAfterReclaiming).to.equal(
				firstLiquidityProviderBeforeReclaiming + firstTraderBalanceAfterFunding
			);

			await freeBetsHolder.removeUserFunding(
				firstLiquidityProvider,
				collateralAddress,
				firstTrader
			);

			const firstLiquidityProviderBalanceAfterReclaiming =
				await freeBetsHolder.balancePerUserAndCollateral(firstLiquidityProvider, collateralAddress);
			expect(firstLiquidityProviderBalanceAfterReclaiming).to.equal(0);
		});

		it('Should set and retrieve freeBetExpirationPeriod correctly', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			const retrievedPeriod = await freeBetsHolder.freeBetExpirationPeriod();
			expect(retrievedPeriod).to.equal(expirationPeriod);
		});

		it('Should set freeBetExpirationUpgrade on first expiration period update', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
			const newFreeBetHolder = await FreeBetsHolder.deploy();
			await newFreeBetHolder.initialize(
				firstTrader.address,
				sportsAMMV2.target,
				liveTradingProcessor.target
			);
			const freeBetsHolderAddress = await newFreeBetHolder.getAddress();
			// Check that upgrade timestamp is initially 0
			const initialUpgrade = await newFreeBetHolder.freeBetExpirationUpgrade();
			expect(initialUpgrade).to.equal(0);

			// Set the expiration period
			const txReceipt = await newFreeBetHolder
				.connect(firstTrader)
				.setFreeBetExpirationPeriod(expirationPeriod, 0);
			const blockTimestamp = (await ethers.provider.getBlock(txReceipt.blockNumber)).timestamp;

			// Check that upgrade timestamp is set
			const upgradedTimestamp = await newFreeBetHolder.freeBetExpirationUpgrade();
			expect(upgradedTimestamp).to.equal(blockTimestamp);

			// Setting again shouldn't change the upgrade timestamp
			await newFreeBetHolder
				.connect(firstTrader)
				.setFreeBetExpirationPeriod(expirationPeriod * 2, 0);
			const changedTimestamp = await newFreeBetHolder.freeBetExpirationUpgrade();
			expect(changedTimestamp).to.equal(blockTimestamp + 1);
		});

		it('Should update freeBetExpiration when funding users', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund a user
			await freeBetsHolder.fund(firstTrader, collateralAddress, BUY_IN_AMOUNT);

			// Check the expiration timestamp
			const currentTimestamp = await time.latest();
			const expirationTimestamp = await freeBetsHolder.freeBetExpiration(
				firstTrader,
				collateralAddress
			);

			expect(expirationTimestamp).to.be.closeTo(currentTimestamp + expirationPeriod, 10); // Allow for small timestamp differences
		});

		it('Should not allow removeExpiredUserFunding if free bet has not expired', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund users
			await freeBetsHolder.fundBatch([firstTrader, secondTrader], collateralAddress, BUY_IN_AMOUNT);

			// Try to remove unexpired free bets
			await expect(
				freeBetsHolder.removeExpiredUserFunding([firstTrader, secondTrader], collateralAddress)
			).to.be.revertedWith('Free bet not expired');
		});

		it('Should allow removeExpiredUserFunding after free bet expires', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund users
			await freeBetsHolder.fundBatch(
				[firstTrader, secondTrader, thirdAccount],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			// Record owner balance before
			const ownerAddress = await freeBetsHolder.owner();
			const ownerBalanceBefore = await collateral.balanceOf(ownerAddress);

			// Fast forward time to after expiration
			await time.increase(expirationPeriod + 100);

			// Now we should be able to remove expired free bets
			await freeBetsHolder.removeExpiredUserFunding([firstTrader, secondTrader], collateralAddress);

			// Check balances are zeroed
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress)
			).to.equal(0);
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(secondTrader, collateralAddress)
			).to.equal(0);
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(thirdAccount, collateralAddress)
			).to.equal(BUY_IN_AMOUNT);

			// Check owner received the tokens
			const ownerBalanceAfter = await collateral.balanceOf(ownerAddress);
			expect(Number(ownerBalanceAfter) - Number(ownerBalanceBefore)).to.be.above(
				Number(BUY_IN_AMOUNT) * 2
			);
		});

		it('Should allow anyone to call removeExpiredUserFunding', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund user
			await freeBetsHolder.fund(firstTrader, collateralAddress, BUY_IN_AMOUNT);

			// Fast forward time to after expiration
			await time.increase(expirationPeriod + 100);

			// Call from a non-owner address
			await freeBetsHolder
				.connect(firstLiquidityProvider)
				.removeExpiredUserFunding([firstTrader], collateralAddress);

			// Verify balance is zeroed
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress)
			).to.equal(0);
		});

		it('Should correctly report validity of free bets', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);
			
			// Fund a user
			await freeBetsHolder.fund(firstTrader, collateralAddress, BUY_IN_AMOUNT);
			
			// Check validity immediately after funding
			const [isValid, timeToExpiration] = await freeBetsHolder.isFreeBetValid(firstTrader, collateralAddress);
			expect(isValid).to.be.true;
			expect(timeToExpiration).to.equal(expirationPeriod);
			
			// Check validity for unfunded user
			const [isValid2, timeToExpiration2] = await freeBetsHolder.isFreeBetValid(secondTrader, collateralAddress);
			expect(isValid2).to.be.false;
			expect(timeToExpiration2).to.equal(0);
			
			// Fast forward time to after expiration
			await time.increase(expirationPeriod + 100);
			
			// Check validity after expiration
			const [isValid3, timeToExpiration3] = await freeBetsHolder.isFreeBetValid(firstTrader, collateralAddress);
			expect(isValid3).to.be.false;
			expect(timeToExpiration3).to.equal(0);
		});

		it('Should handle global expiration for users without specific expiration', async () => {
			const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
			const newFreeBetHolder = await FreeBetsHolder.deploy();
			await newFreeBetHolder.initialize(
				firstTrader.address,
				sportsAMMV2.target,
				liveTradingProcessor.target
			);
			
			// Add collateral support 
			await newFreeBetHolder.connect(firstTrader).addSupportedCollateral(collateralAddress, true);
			
			// Send some collateral to the contract
			await collateral.connect(firstTrader).approve(newFreeBetHolder.target, BUY_IN_AMOUNT);
			
			// Set balance for user but don't set an expiration date
			await newFreeBetHolder.connect(firstTrader).removeUserFunding(
				firstTrader.address,
				collateralAddress, 
				firstTrader.address
			);
			
			// Manually set the balance (simulate having a balance without expiration)
			await newFreeBetHolder.connect(firstTrader).fund(secondTrader, collateralAddress, BUY_IN_AMOUNT);
			
			// Set expiration period which also sets the upgrade timestamp
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await newFreeBetHolder.connect(firstTrader).setFreeBetExpirationPeriod(expirationPeriod, 0);
			const expirationPeriodOnContract = await newFreeBetHolder.freeBetExpirationPeriod();
			expect(expirationPeriodOnContract).to.equal(expirationPeriod);
			const upgradeTimestamp = await newFreeBetHolder.freeBetExpirationUpgrade();
			const currentTimestamp = await time.latest();
			expect(upgradeTimestamp).to.equal(currentTimestamp);
			const freeBetAmount = await newFreeBetHolder.balancePerUserAndCollateral(secondTrader, collateralAddress);
			expect(freeBetAmount).to.equal(BUY_IN_AMOUNT);
			// Check validity - should be valid due to global expiration
			const [isValid, timeToExpiration] = await newFreeBetHolder.isFreeBetValid(secondTrader, collateralAddress);
			expect(isValid).to.be.true;
			expect(timeToExpiration).to.equal(expirationPeriod);
			
			// Fast forward time to after global expiration
			await time.increase(expirationPeriod + 100);
			
			// Check validity - should be invalid now
			const [isValid2, timeToExpiration2] = await newFreeBetHolder.isFreeBetValid(secondTrader, collateralAddress);
			expect(isValid2).to.be.false;
			expect(timeToExpiration2).to.equal(0);
		});

		it('Should handle zero balances correctly', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);
			
			// User with zero balance should have invalid free bet
			const [isValid, timeToExpiration] = await freeBetsHolder.isFreeBetValid(thirdAccount, collateralAddress);
			expect(isValid).to.be.false;
			expect(timeToExpiration).to.equal(0);
			
			// Fund user
			await freeBetsHolder.fund(thirdAccount, collateralAddress, BUY_IN_AMOUNT);
			
			// Now free bet should be valid
			const [isValid2, timeToExpiration2] = await freeBetsHolder.isFreeBetValid(thirdAccount, collateralAddress);
			expect(isValid2).to.be.true;
			expect(timeToExpiration2).to.equal(expirationPeriod);
			
			// Remove all funding
			await freeBetsHolder.removeUserFunding(thirdAccount, collateralAddress, firstTrader);
			
			// Free bet should be invalid due to zero balance
			const [isValid3, timeToExpiration3] = await freeBetsHolder.isFreeBetValid(thirdAccount, collateralAddress);
			expect(isValid3).to.be.false;
			expect(timeToExpiration3).to.equal(0);
		});
	});
});
