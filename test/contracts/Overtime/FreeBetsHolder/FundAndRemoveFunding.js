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
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod);

			const retrievedPeriod = await freeBetsHolder.freeBetExpirationPeriod();
			expect(retrievedPeriod).to.equal(expirationPeriod);
		});

		it('Should set freeBetExpirationUpgrade on first expiration period update', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days

			// Check that upgrade timestamp is initially 0
			const initialUpgrade = await freeBetsHolder.freeBetExpirationUpgrade();
			expect(initialUpgrade).to.equal(0);

			// Set the expiration period
			const txReceipt = await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod);
			const blockTimestamp = (await ethers.provider.getBlock(txReceipt.blockNumber)).timestamp;

			// Check that upgrade timestamp is set
			const upgradedTimestamp = await freeBetsHolder.freeBetExpirationUpgrade();
			expect(upgradedTimestamp).to.equal(blockTimestamp);

			// Setting again shouldn't change the upgrade timestamp
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod * 2);
			const unchangedTimestamp = await freeBetsHolder.freeBetExpirationUpgrade();
			expect(unchangedTimestamp).to.equal(blockTimestamp);
		});

		it('Should update freeBetExpiration when funding users', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod);

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
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod);

			// Fund users
			await freeBetsHolder.fundBatch([firstTrader, secondTrader], collateralAddress, BUY_IN_AMOUNT);

			// Try to remove unexpired free bets
			await expect(
				freeBetsHolder.removeExpiredUserFunding([firstTrader, secondTrader], collateralAddress)
			).to.be.revertedWith('Free bet not expired');
		});

		it('Should allow removeExpiredUserFunding after free bet expires', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod);

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
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod);

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
	});
});
