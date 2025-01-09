const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_SPAIN,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2RiskManager,
		sportsAMMV2LiquidityPool,
		tradeDataThreeMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2RiskManager,
			sportsAMMV2LiquidityPool,
			tradeDataThreeMarketsCurrentRound,
			tradeDataThreeMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade', () => {
		it('Should buy a ticket (10 markets)', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataThreeMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal('42735042735042735042');

			expect(quote.amountsToBuy[0]).to.equal('9230769230769230769');
			expect(quote.amountsToBuy[1]).to.equal('10000000000000000000');
			expect(quote.amountsToBuy[2]).to.equal('1111111111111111111');

			let positionRisk0 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataThreeMarketsCurrentRound[0].gameId,
				tradeDataThreeMarketsCurrentRound[0].typeId,
				tradeDataThreeMarketsCurrentRound[0].playerId,
				0
			);
			let positionRisk1 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataThreeMarketsCurrentRound[1].gameId,
				tradeDataThreeMarketsCurrentRound[1].typeId,
				tradeDataThreeMarketsCurrentRound[1].playerId,
				0
			);

			let positionRisk2 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataThreeMarketsCurrentRound[2].gameId,
				tradeDataThreeMarketsCurrentRound[2].typeId,
				tradeDataThreeMarketsCurrentRound[2].playerId,
				0
			);

			console.log('positionRisk 1 before: ' + positionRisk0);
			console.log('positionRisk 2 before: ' + positionRisk1);
			console.log('positionRisk 3 before: ' + positionRisk2);

			const quoteSystem = await sportsAMMV2.tradeQuoteSystem(
				tradeDataThreeMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false,
				2
			);

			await sportsAMMV2
				.connect(firstTrader)
				.tradeSystemBet(
					tradeDataThreeMarketsCurrentRound,
					BUY_IN_AMOUNT,
					quoteSystem.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false,
					2
				);

			expect(quoteSystem.payout).to.equal('27350427350427350423');

			expect(quoteSystem.amountsToBuy[0]).to.equal('6153846153846153846');
			expect(quoteSystem.amountsToBuy[1]).to.equal('6666666666666666666');
			expect(quoteSystem.amountsToBuy[2]).to.equal('740740740740740740');

			positionRisk0 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataThreeMarketsCurrentRound[0].gameId,
				tradeDataThreeMarketsCurrentRound[0].typeId,
				tradeDataThreeMarketsCurrentRound[0].playerId,
				0
			);
			positionRisk1 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataThreeMarketsCurrentRound[1].gameId,
				tradeDataThreeMarketsCurrentRound[1].typeId,
				tradeDataThreeMarketsCurrentRound[1].playerId,
				0
			);

			positionRisk2 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataThreeMarketsCurrentRound[2].gameId,
				tradeDataThreeMarketsCurrentRound[2].typeId,
				tradeDataThreeMarketsCurrentRound[2].playerId,
				0
			);

			expect(positionRisk0).to.equal('6153846153846153846');
			expect(positionRisk1).to.equal('6666666666666666666');
			expect(positionRisk2).to.equal('740740740740740740');
		});
	});
});
