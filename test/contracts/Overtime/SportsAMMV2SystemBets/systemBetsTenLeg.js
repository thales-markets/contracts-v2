const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	RESULT_TYPE,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	TYPE_ID_WINNER_TOTAL,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 system bets', () => {
	let sportsAMMV2,
		sportsAMMV2RiskManager,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		collateral,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		defaultLiquidityProviderAddress,
		defaultLiquidityProvider;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			collateral,
			sportsAMMV2ResultManager,
			defaultLiquidityProvider,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		defaultLiquidityProviderAddress = await defaultLiquidityProvider.getAddress();

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade', () => {
		it('Should buy a system ticket (2/3 markets)', async () => {
			const maxSystemBetPayoutAndQuote = await sportsAMMV2RiskManager.getMaxSystemBetPayout(
				tradeDataTenMarketsCurrentRound,
				5,
				BUY_IN_AMOUNT,
				0
			);

			await sportsAMMV2
				.connect(firstTrader)
				.tradeSystemBet(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					maxSystemBetPayoutAndQuote.systemBetQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false,
					5
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.isSystem()).to.be.equal(true);

			expect(await userTicket.isTicketExercisable()).to.be.equal(false);

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
				[tradeDataTenMarketsCurrentRound[2].gameId],
				[tradeDataTenMarketsCurrentRound[2].typeId],
				[tradeDataTenMarketsCurrentRound[2].playerId],
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
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[8].gameId],
				[tradeDataTenMarketsCurrentRound[8].typeId],
				[tradeDataTenMarketsCurrentRound[8].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[9].gameId],
				[tradeDataTenMarketsCurrentRound[9].typeId],
				[tradeDataTenMarketsCurrentRound[9].playerId],
				[[0]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(true);

			await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
	});
});
