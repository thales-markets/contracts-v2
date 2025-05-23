const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, SPORT_ID_NBA } = require('../../../constants/overtime');
const { ZERO_ADDRESS, ONE_WEEK_IN_SECS } = require('../../../constants/general');

describe('SportsAMMV2RiskManager Check And Update Risks', () => {
	let sportsAMMV2RiskManager,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		sameGameDifferentPlayersDifferentProps,
		firstTrader,
		firstLiquidityProvider,
		tradeDataNotActive;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			sameGameDifferentPlayersDifferentProps,
			tradeDataNotActive,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('5000'));
		await sportsAMMV2LiquidityPool.start();
		await sportsAMMV2LiquidityPool.setUtilizationRate(ethers.parseEther('1'));
	});
	describe('System bet risk updates', () => {
		it('Should correctly update risks and spentOnGame for first market in a system bet (3 from 10)', async () => {
			const systemBetDenominator = 3;
			const tradeData = tradeDataTenMarketsCurrentRound;
			const numMarkets = tradeData.length;

			for (let i = 0; i < numMarkets; i++) {
				tradeData[i].position = 0;
			}

			const quote = await sportsAMMV2.tradeQuoteSystem(
				tradeData,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false,
				systemBetDenominator
			);

			await sportsAMMV2
				.connect(firstTrader)
				.tradeSystemBet(
					tradeData,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false,
					systemBetDenominator
				);

			const formattedBuyIn = Number(ethers.formatEther(BUY_IN_AMOUNT));
			const market = tradeData[0];
			const odds = Number(ethers.formatEther(market.odds[market.position]));

			const rawMarketRisk = formattedBuyIn / odds - formattedBuyIn;
			const scaledMarketRiskAmount = (rawMarketRisk * systemBetDenominator) / numMarkets;
			const scaledBuyInForRisk = (formattedBuyIn * systemBetDenominator) / numMarkets;

			const riskSelected = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				market.gameId,
				market.typeId,
				market.playerId,
				market.position
			);

			const riskUnselected = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				market.gameId,
				market.typeId,
				market.playerId,
				market.position === 0 ? 1 : 0 // flip position
			);

			const spentOnGame = await sportsAMMV2RiskManager.spentOnGame(market.gameId);

			expect(Number(ethers.formatEther(riskSelected)).toFixed(4)).to.equal(
				scaledMarketRiskAmount.toFixed(4)
			);

			expect(Number(ethers.formatEther(riskUnselected)).toFixed(4)).to.equal(
				Number(-scaledBuyInForRisk).toFixed(4)
			);

			expect(Number(ethers.formatEther(spentOnGame)).toFixed(4)).to.equal(
				scaledMarketRiskAmount.toFixed(4)
			);
		});
	});
});
