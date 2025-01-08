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
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
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
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade with free bet', () => {
		it('Should pass system', async () => {
			const quote = await sportsAMMV2.tradeQuoteSystem(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				collateralAddress,
				false,
				3
			);

			await freeBetsHolder
				.connect(firstTrader)
				.tradeSystemBet(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress,
					3
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.isSystem()).to.be.equal(true);

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, 11029],
				[
					RESULT_TYPE.ExactPosition,
					RESULT_TYPE.OverUnder,
					RESULT_TYPE.Spread,
					RESULT_TYPE.OverUnder,
				]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[0].gameId],
				[tradeDataTenMarketsCurrentRound[0].typeId],
				[tradeDataTenMarketsCurrentRound[0].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[1].gameId],
				[tradeDataTenMarketsCurrentRound[1].typeId],
				[tradeDataTenMarketsCurrentRound[1].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[2].gameId],
				[tradeDataTenMarketsCurrentRound[2].typeId],
				[tradeDataTenMarketsCurrentRound[2].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[3].gameId],
				[tradeDataTenMarketsCurrentRound[3].typeId],
				[tradeDataTenMarketsCurrentRound[3].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[4].gameId],
				[tradeDataTenMarketsCurrentRound[4].typeId],
				[tradeDataTenMarketsCurrentRound[4].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[5].gameId],
				[tradeDataTenMarketsCurrentRound[5].typeId],
				[tradeDataTenMarketsCurrentRound[5].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[6].gameId],
				[tradeDataTenMarketsCurrentRound[6].typeId],
				[tradeDataTenMarketsCurrentRound[6].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[7].gameId],
				[tradeDataTenMarketsCurrentRound[7].typeId],
				[tradeDataTenMarketsCurrentRound[8].playerId],
				[[1]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[8].gameId],
				[tradeDataTenMarketsCurrentRound[8].typeId],
				[tradeDataTenMarketsCurrentRound[8].playerId],
				[[1]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[9].gameId],
				[tradeDataTenMarketsCurrentRound[9].typeId],
				[tradeDataTenMarketsCurrentRound[9].playerId],
				[[1]]
			);

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('0'));

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const firstTraderBalanceAfter = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfter).to.equal(ethers.parseEther('4.000914494741655190'));
		});
	});
});
