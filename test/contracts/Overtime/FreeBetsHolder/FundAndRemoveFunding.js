const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
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
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

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
	});
});
