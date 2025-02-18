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
		sameGameWithFirstPlayerProps,
		firstLiquidityProvider,
		firstTrader,
		freeBetsHolder,
		collateralAddress,
		sportsAMMV2RiskManager,
		mockChainlinkOracle,
		sgpTradingProcessor,
		sportsAMMV2ResultManager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			sameGameWithFirstPlayerProps,
			freeBetsHolder,
			collateralAddress,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			sgpTradingProcessor,
			sportsAMMV2ResultManager,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
		await sportsAMMV2RiskManager.setSGPEnabledOnSportIds([SPORT_ID_NBA], true);
	});

	describe('Trade with free bet SGP', () => {
		it('Set SportsAMM and SGPTradingProcessor and test trade', async () => {
			const sportsAMMAddress = await sportsAMMV2.getAddress();
			const sgpTradingProcessorAddress = await sgpTradingProcessor.getAddress();
			await freeBetsHolder.setSportsAMM(sportsAMMAddress);
			await freeBetsHolder.setSGPTradingProcessor(sgpTradingProcessorAddress);

			const SportsAMMSet = await freeBetsHolder.sportsAMM();
			const SGPTradingSet = await freeBetsHolder.sgpTradingProcessor();
			expect(SportsAMMSet).to.equal(sportsAMMAddress);
			expect(SGPTradingSet).to.equal(sgpTradingProcessorAddress);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			let approvedQuote = ethers.parseEther('0.5');

			await freeBetsHolder.connect(firstTrader).tradeSGP({
				_tradeData: sameGameWithFirstPlayerProps,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: approvedQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: collateralAddress,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillSGPTrade(requestId, true, quote.totalQuote);
		});
	});
});
