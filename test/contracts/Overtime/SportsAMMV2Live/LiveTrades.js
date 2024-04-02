const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, SPORT_ID_NBA } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		liveTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		quote;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			liveTradingProcessor,
			mockChainlinkOracle,
			sportsAMMV2RiskManager,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, ZERO_ADDRESS);
	});

	describe('Live Trade', () => {
		it('Should buy a live trade', async () => {
			expect(quote.payout).to.equal(ethers.parseEther('20'));

			await sportsAMMV2RiskManager.setLiveTradingPerSportEnabled(SPORT_ID_NBA, true);

			await liveTradingProcessor
				.connect(firstTrader)
				.requestLiveTrade(
					tradeDataCurrentRound[0].gameId,
					tradeDataCurrentRound[0].sportId,
					tradeDataCurrentRound[0].position,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					firstTrader,
					ZERO_ADDRESS,
					ZERO_ADDRESS
				);

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.payout);
		});

		it('Fail for unsupported sports', async () => {
			await expect(
				liveTradingProcessor
					.connect(firstTrader)
					.requestLiveTrade(
						tradeDataCurrentRound[0].gameId,
						tradeDataCurrentRound[0].sportId,
						tradeDataCurrentRound[0].position,
						BUY_IN_AMOUNT,
						quote.payout,
						ADDITIONAL_SLIPPAGE,
						firstTrader,
						ZERO_ADDRESS,
						ZERO_ADDRESS
					)
			).to.be.revertedWith('Live trading not enabled on _sportId');
		});

		it('Fail for double fulfillment', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportEnabled(SPORT_ID_NBA, true);

			await liveTradingProcessor
				.connect(firstTrader)
				.requestLiveTrade(
					tradeDataCurrentRound[0].gameId,
					tradeDataCurrentRound[0].sportId,
					tradeDataCurrentRound[0].position,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					firstTrader,
					ZERO_ADDRESS,
					ZERO_ADDRESS
				);

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.payout);

			await expect(
				mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.payout)
			).to.be.revertedWith('Source must be the oracle of the request');
		});

		it('Fail with delay on execution', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportEnabled(SPORT_ID_NBA, true);

			await liveTradingProcessor
				.connect(firstTrader)
				.requestLiveTrade(
					tradeDataCurrentRound[0].gameId,
					tradeDataCurrentRound[0].sportId,
					tradeDataCurrentRound[0].position,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					firstTrader,
					ZERO_ADDRESS,
					ZERO_ADDRESS
				);

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			// delay the response more than allowed
			await time.increase(61);

			await expect(
				mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.payout)
			).to.be.revertedWith('Request timed out');
		});

		it('Fail on slippage', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportEnabled(SPORT_ID_NBA, true);

			await liveTradingProcessor
				.connect(firstTrader)
				.requestLiveTrade(
					tradeDataCurrentRound[0].gameId,
					tradeDataCurrentRound[0].sportId,
					tradeDataCurrentRound[0].position,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					firstTrader,
					ZERO_ADDRESS,
					ZERO_ADDRESS
				);

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await expect(
				mockChainlinkOracle.fulfillLiveTrade(
					requestId,
					true,
					ethers.parseEther((ethers.formatEther(quote.payout) / 2).toString())
				)
			).to.be.revertedWith('Slippage too high');
		});
	});
});
