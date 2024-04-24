const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, RESULT_TYPE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const {
	SPORTS_AMM_INITAL_PARAMS,
	RISK_MANAGER_INITAL_PARAMS,
} = require('../../../constants/overtimeContractParams');

describe('SportsAMMV2Data Read Data', () => {
	let sportsAMMV2Data,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		tradeDataTenMarketsCurrentRound,
		firstTrader,
		firstLiquidityProvider,
		ticketAddress,
		numberOfGamesOnTicket;

	beforeEach(async () => {
		({
			sportsAMMV2Data,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const quote = await sportsAMMV2.tradeQuote(
			tradeDataTenMarketsCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS
		);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		ticketAddress = activeTickets[0];
		numberOfGamesOnTicket = tradeDataTenMarketsCurrentRound.length;
	});

	describe('Sports AMM data', () => {
		it('Should return Sports AMM parameters', async () => {
			const params = await sportsAMMV2Data.getSportsAMMParameters();

			expect(params.minBuyInAmount).to.be.equal(RISK_MANAGER_INITAL_PARAMS.minBuyInAmount);
			expect(params.maxTicketSize).to.be.equal(RISK_MANAGER_INITAL_PARAMS.maxTicketSize);
			expect(params.maxSupportedAmount).to.be.equal(RISK_MANAGER_INITAL_PARAMS.maxSupportedAmount);
			expect(params.maxSupportedOdds).to.be.equal(RISK_MANAGER_INITAL_PARAMS.maxSupportedOdds);
			expect(params.safeBoxFee).to.be.equal(SPORTS_AMM_INITAL_PARAMS.safeBoxFee);
		});
	});

	describe('Sports AMM Manager Data', () => {
		it('Should read ticket data active/resolved from SportsAMMV2Manager', async () => {
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];
			expect(await sportsAMMV2Manager.isActiveTicket(ticketAddress)).to.be.equal(true);
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.be.equal(1);
			const activeTicketsForUser = await sportsAMMV2Manager.getActiveTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(activeTicketsForUser[0]).to.be.equal(ticketAddress);
			expect(await sportsAMMV2Manager.numOfActiveTicketsPerUser(firstTrader)).to.be.equal(1);

			const resolvedTicketsForUser = await sportsAMMV2Manager.getResolvedTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(resolvedTicketsForUser.length).to.be.equal(0);
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.be.equal(0);

			const firstGameId = tradeDataTenMarketsCurrentRound[0].gameId;
			const ticketsPerGame = await sportsAMMV2Manager.getTicketsPerGame(0, 100, firstGameId);
			expect(ticketsPerGame[0]).to.be.equal(ticketAddress);
			expect(await sportsAMMV2Manager.numOfTicketsPerGame(firstGameId)).to.be.equal(1);
		});
	});

	describe('Tickets data', () => {
		it('Should return tickets data', async () => {
			const ticketsData = await sportsAMMV2Data.getTicketsData([ticketAddress]);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
		});

		it('Should return active tickets data per user', async () => {
			const firstTraderAddress = await firstTrader.getAddress();
			const ticketsData = await sportsAMMV2Data.getActiveTicketsDataPerUser(firstTrader);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
			expect(ticketsData[0].ticketOwner).to.be.equal(firstTraderAddress);
		});

		it('Should return resolved tickets data per user', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
			// resolve as losing for user
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[0].gameId],
				[tradeDataTenMarketsCurrentRound[0].typeId],
				[tradeDataTenMarketsCurrentRound[0].playerId],
				[[1]]
			);
			await sportsAMMV2.exerciseTicket(ticketAddress);

			const firstTraderAddress = await firstTrader.getAddress();
			const ticketsData = await sportsAMMV2Data.getResolvedTicketsDataPerUser(firstTrader);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(true);
			expect(ticketsData[0].isLost).to.be.equal(true);
			expect(ticketsData[0].isUserTheWinner).to.be.equal(false);
			expect(ticketsData[0].ticketOwner).to.be.equal(firstTraderAddress);
		});

		it('Should return tickets data per game', async () => {
			const firstGameId = tradeDataTenMarketsCurrentRound[0].gameId;

			const ticketsData = await sportsAMMV2Data.getTicketsDataPerGame(firstGameId);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
			expect(ticketsData[0].marketsData[0].gameId).to.be.equal(firstGameId);
		});
	});
});
