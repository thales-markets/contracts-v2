const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, SPORT_ID_NBA } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

// Player prop market typeId: 11029 Player Points
const TYPE_ID_PLAYER_POINTS = 11029;
const PLAYER_ID = 1234; // arbitrary uint24 test player id

describe('SportsAMMV2Live Live Trades - Player Props', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolETH,
		tradeDataCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		secondAccount,
		owner,
		liveTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		weth,
		quote,
		sportsAMMV2Manager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2LiquidityPoolETH,
			tradeDataCurrentRound,
			liveTradingProcessor,
			mockChainlinkOracle,
			weth,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ owner, firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));

		// Fund LPs so live trades can be executed
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await sportsAMMV2LiquidityPoolETH
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1'));
		await sportsAMMV2LiquidityPoolETH.start();

		// Base quote we’ll reuse for expectedQuote / approvedQuote
		quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, ZERO_ADDRESS, false);
	});

	describe('Live Player Props Trade', () => {
		it('Should buy a live player points prop trade (typeId 11029) and forward playerId', async () => {
			// GIVEN live trading enabled for NBA + Player Points (11029)
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(
				SPORT_ID_NBA,
				TYPE_ID_PLAYER_POINTS,
				true
			);

			// WHEN requesting a live trade for a player points market with non-zero playerId
			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: TYPE_ID_PLAYER_POINTS, // Player Points type
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
				_playerId: PLAYER_ID, // non-zero playerId
			});

			const requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('player props requestId is ' + requestId);

			// THEN stored trade data should have correct typeId + playerId
			const storedTradeData = await liveTradingProcessor.getTradeData(requestId);
			expect(storedTradeData._typeId).to.eq(TYPE_ID_PLAYER_POINTS);
			expect(storedTradeData._playerId).to.eq(PLAYER_ID);

			// AND fulfillment via mock oracle should succeed
			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);

			// AND a live ticket should be created
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			expect(activeTickets.length).to.be.greaterThan(0);

			const ticketAddress = activeTickets[0];
			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			// Ticket is live
			expect(await userTicket.isLive()).to.eq(true);

			// Optional sanity check on odds (same as existing live tests)
			const marketData = await userTicket.markets(0);
			expect(marketData.odd).to.equal(ethers.parseEther('0.5'));
		});
	});
});
