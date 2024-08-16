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
	SPORT_ID_NBA,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2THALESLiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		safeBoxTHALESAddress,
		collateralTHALES,
		collateralTHALESAddress,
		sportsAMMV2ResultManager,
		sportsAMMV2Manager,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		liveTradingProcessor;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2THALESLiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			collateralTHALESAddress,
			safeBoxTHALESAddress,
			collateralTHALES,
			sportsAMMV2ResultManager,
			sportsAMMV2Manager,
			mockChainlinkOracle,
			sportsAMMV2RiskManager,
			liveTradingProcessor,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2THALESLiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2THALESLiquidityPool.start();

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade', () => {
		it('Should buy a ticket (1 market) in THALES', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			const quoteTHALES = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			console.log('Normal quote is: ' + quote.totalQuote);
			console.log('THALES quote is: ' + quoteTHALES.totalQuote);

			expect(quoteTHALES.payout).greaterThan(quote.payout);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralTHALESAddress,
					false
				);

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataCurrentRound[0].gameId],
				[tradeDataCurrentRound[0].typeId],
				[tradeDataCurrentRound[0].playerId],
				[[0]]
			);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);

			const safeBoxTHALESBalance = await collateralTHALES.balanceOf(safeBoxTHALESAddress);
			expect(safeBoxTHALESBalance).greaterThan(0);
		});

		it('Should buy a ticket (10 markets) with THALES', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal('28679719907924413133');

			const quoteTHALES = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			console.log('Normal quote is: ' + quote.totalQuote);
			console.log('THALES quote is: ' + quoteTHALES.totalQuote);

			expect(quoteTHALES.payout).greaterThan(quote.payout);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralTHALESAddress,
					false
				);
		});

		it('Should buy a live trade with THALES', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: collateralTHALESAddress,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			const marketData = await userTicket.markets(0);

			console.log('Normal quote is: ' + quote.totalQuote);
			console.log('THALES live quote is: ' + marketData.odd);

			expect(marketData.odd).to.greaterThan(ethers.parseEther('0.495'));
			expect(marketData.odd).to.lessThan(ethers.parseEther('0.496'));

			expect(await userTicket.isLive()).to.eq(true);
		});

		it('Should buy a ticket (1 market) in THALES which gets cancelled', async () => {
			const quoteTHALES = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			const userBalanceBefore = await collateralTHALES.balanceOf(firstTrader);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quoteTHALES.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralTHALESAddress,
					false
				);

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataCurrentRound[0].gameId],
				[tradeDataCurrentRound[0].typeId],
				[tradeDataCurrentRound[0].playerId],
				[[-9999]]
			);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);

			const safeBoxTHALESBalance = await collateralTHALES.balanceOf(safeBoxTHALESAddress);
			expect(safeBoxTHALESBalance).eq(0);

			const userBalanceAfter = await collateralTHALES.balanceOf(firstTrader);

			expect(userBalanceBefore).eq(userBalanceAfter);
		});
	});
});
