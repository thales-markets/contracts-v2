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
		tradeDataTenMarketsCurrentRoundImmutable,
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
			tradeDataTenMarketsCurrentRoundImmutable,
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
		it('Should buy a system ticket (2/10 markets)', async () => {
			await sportsAMMV2RiskManager.setTicketParams(
				ethers.parseEther('3'),
				15,
				ethers.parseEther('20000'),
				ethers.parseEther('0.5'), // 2x
				500 // max combinations
			);

			const maxSystemBetPayoutAndQuote = await sportsAMMV2RiskManager.getMaxSystemBetPayout(
				tradeDataTenMarketsCurrentRoundImmutable,
				8,
				BUY_IN_AMOUNT,
				0
			);

			await sportsAMMV2.connect(firstTrader).tradeSystemBet(
				tradeDataTenMarketsCurrentRoundImmutable,
				BUY_IN_AMOUNT,
				maxSystemBetPayoutAndQuote.systemBetQuote,
				ethers.parseEther('0.5'), // 50% additional slippage
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false,
				8
			);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			let ticketQuote = await userTicket.totalQuote();
			console.log('ticketQuote: ' + ticketQuote.toString() / 1e18);

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
				[tradeDataTenMarketsCurrentRoundImmutable[0].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[0].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[0].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[1].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[1].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[1].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[2].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[2].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[2].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[2].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[2].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[2].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[3].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[3].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[3].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[2].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[2].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[2].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[4].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[4].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[4].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[5].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[5].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[5].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[6].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[6].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[6].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[7].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[7].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[8].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[8].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[8].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[8].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRoundImmutable[9].gameId],
				[tradeDataTenMarketsCurrentRoundImmutable[9].typeId],
				[tradeDataTenMarketsCurrentRoundImmutable[9].playerId],
				[[0]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(true);

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('10010'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
	});
});
