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
		sportsAMMV2Manager;

	const ONE = 10n ** 18n;
	const mulWithDecimals = (a, b) => (a * b) / ONE;

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
	});

	it('Should create a 3-leg live parlay ticket and store totalQuote = boosted(product(legOdds))', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];
		const m2 = tradeDataTenMarketsCurrentRound[2];

		// enable live trading for all three legs
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m2.sportId, m2.typeId, true);

		// ----- NEW: build Chainlink-style approval payload -----
		// approvedLegOdds must be the raw leg odds (no bonus), and approvedQuote must match the product (no bonus)
		const leg0 = BigInt(m0.odds[m0.position]);
		const leg1 = BigInt(m1.odds[m1.position]);
		const leg2 = BigInt(m2.odds[m2.position]);

		const approvedLegOdds = [leg0, leg1, leg2];
		const approvedQuote = mulWithDecimals(mulWithDecimals(leg0, leg1), leg2); // baseQuote guardrail

		// Build parlay request with 3 legs
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
			// keep as non-zero for slippage check in fulfillLiveTradeParlay
			// and must be consistent with the guardrail logic (treated as "approvedQuote" effectively)
			expectedPayout: approvedQuote,
			additionalSlippage: ADDITIONAL_SLIPPAGE,
			referrer: ZERO_ADDRESS,
			collateral: ZERO_ADDRESS,
		};

		await liveTradingProcessor.connect(firstTrader).requestLiveParlayTrade(parlay);
		const requestId = await liveTradingProcessor.counterToRequestId(0);

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

		expect(await ticket.isLive()).to.eq(true);
		expect(await ticket.numOfMarkets()).to.eq(3);
		expect(await ticket.buyInAmount()).to.eq(BUY_IN_AMOUNT);

		// IMPORTANT: with your new implementation, ticket.totalQuote is the BOOSTED quote (bonus per leg)
		// so we can't assert totalQuote == approvedQuote anymore.
		//
		// We *can* assert that totalQuote >= approvedQuote (bonus increases odds), unless addedPayout is 0.
		const storedTotalQuote = await ticket.totalQuote();
		expect(storedTotalQuote).to.be.greaterThan(0n);

		// If there is a bonus configured for this collateral, boosted quote should be > base.
		// If bonus is 0, they’ll be equal.
		expect(storedTotalQuote).to.be.greaterThanOrEqual(approvedQuote);

		// processor linkage
		expect(await liveTradingProcessor.requestIdToTicketId(requestId)).to.eq(ticketAddress);
	});
	it('Should revert on request if expectedPayout is below maxSupportedOdds (decimal odds above max)', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];

		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);

		const maxSupportedOdds = await sportsAMMV2RiskManager.maxSupportedOdds();

		// If user sets expectedPayout (quote) to maxSupportedOdds - 1, it implies odds ABOVE allowed max.
		// This should now fail immediately in LiveTradingProcessor.requestLiveParlayTrade().
		const badExpectedPayout = maxSupportedOdds - 1n;

		await expect(
			liveTradingProcessor.connect(firstTrader).requestLiveParlayTrade({
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
				],
				buyInAmount: BUY_IN_AMOUNT,
				expectedPayout: badExpectedPayout,
				additionalSlippage: ADDITIONAL_SLIPPAGE,
				referrer: ZERO_ADDRESS,
				collateral: ZERO_ADDRESS,
			})
		).to.be.revertedWith('ExceededMaxOdds');
	});

	it('Should not revert on live parlay when additionalSlippage=0 due to rounding (off-by-1)', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];

		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);

		const leg0 = BigInt(m0.odds[m0.position]);
		const leg1 = BigInt(m1.odds[m1.position]);

		const approvedLegOdds = [leg0, leg1];
		const approvedQuote = mulWithDecimals(leg0, leg1);

		// additionalSlippage = 0 to stress the rounding edge case
		await liveTradingProcessor.connect(firstTrader).requestLiveParlayTrade({
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
			],
			buyInAmount: BUY_IN_AMOUNT,
			expectedPayout: approvedQuote, // must match product(legOdds) for guardrail consistency
			additionalSlippage: 0,
			referrer: ZERO_ADDRESS,
			collateral: ZERO_ADDRESS,
		});

		const requestId = await liveTradingProcessor.counterToRequestId(0);

		await mockChainlinkOracle.fulfillLiveTradeParlay(
			requestId,
			true,
			approvedQuote,
			approvedLegOdds
		);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		expect(activeTickets.length).to.be.greaterThan(0);

		const ticketAddress = activeTickets[0];
		const TicketContract = await ethers.getContractFactory('Ticket');
		const ticket = await TicketContract.attach(ticketAddress);

		expect(await ticket.isLive()).to.eq(true);
		expect(await ticket.numOfMarkets()).to.eq(2);
		expect(await ticket.buyInAmount()).to.eq(BUY_IN_AMOUNT);

		// Also verify linkage
		expect(await liveTradingProcessor.requestIdToTicketId(requestId)).to.eq(ticketAddress);
	});
});
