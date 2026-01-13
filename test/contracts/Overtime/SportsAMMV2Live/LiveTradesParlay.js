const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('SportsAMMV2Live Live Parlay Trades - Quote Assertions (3 legs)', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolETH,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		liveTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		sportsAMMV2Manager,
		singleQuote;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2LiquidityPoolETH,
			tradeDataTenMarketsCurrentRound,
			liveTradingProcessor,
			mockChainlinkOracle,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		// fund LPs
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await sportsAMMV2LiquidityPoolETH
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1'));
		await sportsAMMV2LiquidityPoolETH.start();

		// just to get a deterministic "approvedQuote" value we can reuse
		singleQuote = await sportsAMMV2.tradeQuote(
			[tradeDataTenMarketsCurrentRound[0]],
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);
	});

	it('Should create a 3-leg live parlay ticket and store totalQuote = approvedQuote', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];
		const m2 = tradeDataTenMarketsCurrentRound[2];

		// enable live trading for all three legs
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m2.sportId, m2.typeId, true);

		// This is what we want to assert later ends up as Ticket.totalQuote
		const approvedQuote = singleQuote.totalQuote;

		// Build parlay request with 3 legs (gameId is string in interface)
		const parlay = {
			legs: [
				{
					gameId: m0.gameId,
					sportId: m0.sportId,
					typeId: m0.typeId,
					line: m0.line,
					position: m0.position,
					expectedLegOdd: 0,
					playerId: 0,
				},
				{
					gameId: m1.gameId,
					sportId: m1.sportId,
					typeId: m1.typeId,
					line: m1.line,
					position: m1.position,
					expectedLegOdd: 0,
					playerId: 0,
				},
				{
					gameId: m2.gameId,
					sportId: m2.sportId,
					typeId: m2.typeId,
					line: m2.line,
					position: m2.position,
					expectedLegOdd: 0,
					playerId: 0,
				},
			],
			buyInAmount: BUY_IN_AMOUNT,
			// must be non-zero due to slippage check in fulfillLiveTradeParlay
			expectedPayout: approvedQuote,
			additionalSlippage: ADDITIONAL_SLIPPAGE,
			referrer: ZERO_ADDRESS,
			collateral: ZERO_ADDRESS,
		};

		await liveTradingProcessor.connect(firstTrader).requestLiveParlayTrade(parlay);

		const requestId = await liveTradingProcessor.counterToRequestId(0);

		// PARLAY fulfill: leg odds array must match legs length
		const approvedLegOdds = [approvedQuote, approvedQuote, approvedQuote];

		// UPDATED: call the parlay fulfill on the mock
		await mockChainlinkOracle.fulfillLiveTradeParlay(
			requestId,
			true,
			approvedQuote,
			approvedLegOdds
		);

		// ticket created
		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		expect(activeTickets.length).to.be.greaterThan(0);

		const ticketAddress = activeTickets[0];
		const TicketContract = await ethers.getContractFactory('Ticket');
		const ticket = await TicketContract.attach(ticketAddress);

		// core asserts
		expect(await ticket.isLive()).to.eq(true);
		expect(await ticket.numOfMarkets()).to.eq(3);
		expect(await ticket.buyInAmount()).to.eq(BUY_IN_AMOUNT);

		// quote correctness check
		expect(await ticket.totalQuote()).to.eq(approvedQuote);

		// processor linkage
		expect(await liveTradingProcessor.requestIdToTicketId(requestId)).to.eq(ticketAddress);
	});
});
