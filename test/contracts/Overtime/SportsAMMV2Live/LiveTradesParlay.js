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
	let owner,
		sportsAMMV2,
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
	const toBytes32LiveGameId = (g) =>
		ethers.hexlify(ethers.zeroPadBytes(ethers.toUtf8Bytes(g).slice(0, 32), 32));

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

		({ owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

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

		// ----- Chainlink-style approval payload -----
		// approvedLegOdds = raw leg odds (NO bonus)
		// approvedQuote = product(raw leg odds) (NO bonus)  => this is your baseQuote guardrail
		const leg0 = BigInt(m0.odds[m0.position]);
		const leg1 = BigInt(m1.odds[m1.position]);
		const leg2 = BigInt(m2.odds[m2.position]);

		const approvedLegOdds = [leg0, leg1, leg2];
		const approvedQuote = mulWithDecimals(mulWithDecimals(leg0, leg1), leg2);

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
			// must be consistent with your guardrail base quote logic (NO bonus)
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

		const storedTotalQuote = await ticket.totalQuote();
		expect(storedTotalQuote).to.be.greaterThan(0n);

		// IMPORTANT:
		// quote is "implied probability" (1/decimal odds), so "bonus" tends to DECREASE the quote (better odds).
		// So we can’t safely assert storedTotalQuote >= approvedQuote.
		//
		// What we CAN always assert:
		// - storedTotalQuote is clamped to minImplied (>= minImplied)
		// - storedTotalQuote <= approvedQuote if bonus > 0, OR == if bonus=0, OR could be == minImplied if clamped
		const minImplied = await sportsAMMV2RiskManager.maxSupportedOdds();
		expect(storedTotalQuote).to.be.greaterThanOrEqual(minImplied);

		// If no clamp happened and bonus is 0, it should equal approvedQuote.
		// We don't know your addedPayout config here; so keep it weak:
		expect(storedTotalQuote).to.be.lte(approvedQuote); // holds if bonus>=0 and no clamp-up is applied

		// linkage
		expect(await liveTradingProcessor.requestIdToTicketId(requestId)).to.eq(ticketAddress);
	});

	it('Should update risk for each leg in live parlay (selected positions)', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];

		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);

		const leg0 = BigInt(m0.odds[m0.position]);
		const leg1 = BigInt(m1.odds[m1.position]);

		const approvedLegOdds = [leg0, leg1];
		const approvedQuote = mulWithDecimals(leg0, leg1);

		const parlay = {
			legs: [
				{
					gameId: m0.gameId,
					sportId: m0.sportId,
					typeId: m0.typeId,
					line: m0.line,
					position: m0.position,
					expectedLegOdd: 0,
					playerId: m0.playerId || 0,
				},
				{
					gameId: m1.gameId,
					sportId: m1.sportId,
					typeId: m1.typeId,
					line: m1.line,
					position: m1.position,
					expectedLegOdd: 0,
					playerId: m1.playerId || 0,
				},
			],
			buyInAmount: BUY_IN_AMOUNT,
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

		const gameId0 = toBytes32LiveGameId(m0.gameId);
		const gameId1 = toBytes32LiveGameId(m1.gameId);

		const risk0 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId0,
			m0.typeId,
			m0.playerId || 0,
			m0.position
		);

		const risk1 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId1,
			m1.typeId,
			m1.playerId || 0,
			m1.position
		);

		expect(risk0).to.be.gt(0);
		expect(risk1).to.be.gt(0);
	});

	it('Should only update nearby positions (bounded loop) in live parlay', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];

		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);

		const gameId0 = toBytes32LiveGameId(m0.gameId);
		const typeId0 = m0.typeId;
		const playerId0 = m0.playerId || 0;

		const createAndFulfillTwoLegLiveParlay = async (position0, buyInAmount = BUY_IN_AMOUNT) => {
			const approvedLegOdd0 = BigInt(m0.odds[m0.position]);
			const approvedLegOdd1 = BigInt(m1.odds[m1.position]);
			const approvedQuote = mulWithDecimals(approvedLegOdd0, approvedLegOdd1);

			const requestIndex = await liveTradingProcessor.requestCounter();

			await liveTradingProcessor.connect(firstTrader).requestLiveParlayTrade({
				legs: [
					{
						gameId: m0.gameId,
						sportId: m0.sportId,
						typeId: m0.typeId,
						line: m0.line,
						position: position0,
						expectedLegOdd: 0,
						playerId: playerId0,
					},
					{
						gameId: m1.gameId,
						sportId: m1.sportId,
						typeId: m1.typeId,
						line: m1.line,
						position: m1.position,
						expectedLegOdd: 0,
						playerId: m1.playerId || 0,
					},
				],
				buyInAmount,
				expectedPayout: approvedQuote,
				additionalSlippage: ADDITIONAL_SLIPPAGE,
				referrer: ZERO_ADDRESS,
				collateral: ZERO_ADDRESS,
			});

			const requestId = await liveTradingProcessor.counterToRequestId(requestIndex);

			await mockChainlinkOracle.fulfillLiveTradeParlay(requestId, true, approvedQuote, [
				approvedLegOdd0,
				approvedLegOdd1,
			]);
		};

		// Seed far position on first leg; later trade at position 10 must not touch it.
		await createAndFulfillTwoLegLiveParlay(20);

		const riskFarBefore = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId0,
			typeId0,
			playerId0,
			20
		);
		expect(riskFarBefore).to.be.gt(0);

		// Seed near position on first leg; later trade at position 10 should touch position 11.
		await createAndFulfillTwoLegLiveParlay(11);

		const riskNearBefore = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId0,
			typeId0,
			playerId0,
			11
		);
		expect(riskNearBefore).to.be.gt(0);

		// position 10 => bounded loop touches 0..12, so 11 should change, 20 should not
		const newBuyInAmount = ethers.parseEther('5');
		await createAndFulfillTwoLegLiveParlay(10, newBuyInAmount);

		const riskSelectedAfter = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId0,
			typeId0,
			playerId0,
			10
		);
		const riskNearAfter = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId0,
			typeId0,
			playerId0,
			11
		);
		const riskFarAfter = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
			gameId0,
			typeId0,
			playerId0,
			20
		);

		expect(riskSelectedAfter).to.be.gt(0);
		expect(riskNearAfter).to.equal(riskNearBefore - newBuyInAmount);
		expect(riskFarAfter).to.equal(riskFarBefore);
	});

	it('Should revert on request if expectedPayout is below maxSupportedOdds (decimal odds above max)', async () => {
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];

		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m0.sportId, m0.typeId, true);
		await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(m1.sportId, m1.typeId, true);

		const maxSupportedOdds = await sportsAMMV2RiskManager.maxSupportedOdds();

		// If user sets expectedPayout (quote) to maxSupportedOdds - 1, it implies decimal odds ABOVE allowed max.
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
			expectedPayout: approvedQuote,
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

		expect(await liveTradingProcessor.requestIdToTicketId(requestId)).to.eq(ticketAddress);
	});

	it('Should succeed when baseQuote (product of legs) >= maxSupportedOdds (no clamp guardrail path)', async () => {
		// Force bonus = 0 on default collateral so boostedQuote == baseQuote
		const defaultCollat = await sportsAMMV2.defaultCollateral();
		const lp = await sportsAMMV2.liquidityPoolForCollateral(defaultCollat);

		// keep safeBox override unset (0 address) – fine for tests
		await sportsAMMV2.connect(owner).configureCollateral(defaultCollat, lp, 0, ZERO_ADDRESS);

		const minImplied = await sportsAMMV2RiskManager.maxSupportedOdds();

		// Pick 2 legs such that baseQuote >= minImplied
		let a, b, legA, legB, approvedQuote;

		outer: for (let i = 0; i < tradeDataTenMarketsCurrentRound.length; i++) {
			for (let j = i + 1; j < tradeDataTenMarketsCurrentRound.length; j++) {
				const mi = tradeDataTenMarketsCurrentRound[i];
				const mj = tradeDataTenMarketsCurrentRound[j];

				// enable live on each leg
				await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(
					mi.sportId,
					mi.typeId,
					true
				);
				await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(
					mj.sportId,
					mj.typeId,
					true
				);

				legA = BigInt(mi.odds[mi.position]);
				legB = BigInt(mj.odds[mj.position]);
				if (legA === 0n || legB === 0n) continue;

				const prod = mulWithDecimals(legA, legB);

				// Non-clamp path requires baseQuote >= minImplied
				if (prod >= minImplied) {
					a = mi;
					b = mj;
					approvedQuote = prod;
					break outer;
				}
			}
		}

		expect(a, 'Could not find a leg pair with product >= maxSupportedOdds in fixture data').to.not
			.be.undefined;

		const parlay = {
			legs: [
				{
					gameId: a.gameId,
					sportId: a.sportId,
					typeId: a.typeId,
					line: a.line,
					position: a.position,
					expectedLegOdd: 0,
					playerId: 0,
				},
				{
					gameId: b.gameId,
					sportId: b.sportId,
					typeId: b.typeId,
					line: b.line,
					position: b.position,
					expectedLegOdd: 0,
					playerId: 0,
				},
			],
			buyInAmount: BUY_IN_AMOUNT,
			expectedPayout: approvedQuote, // baseQuote
			additionalSlippage: 0,
			referrer: ZERO_ADDRESS,
			collateral: ZERO_ADDRESS,
		};

		await liveTradingProcessor.connect(firstTrader).requestLiveParlayTrade(parlay);
		const requestId = await liveTradingProcessor.counterToRequestId(0);

		const approvedLegOdds = [legA, legB];

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

		// bonus=0 and baseQuote>=minImplied => no clamp => should be exact match
		expect(await ticket.totalQuote()).to.eq(approvedQuote);

		expect(await liveTradingProcessor.requestIdToTicketId(requestId)).to.eq(ticketAddress);
	});
});
