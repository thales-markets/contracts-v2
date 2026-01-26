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
		sportsAMMV2ResultManager,
		collateral;

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
			collateral,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await collateral.mintForUser(firstLiquidityProvider);
		await collateral
			.connect(firstLiquidityProvider)
			.approve(freeBetsHolder.target, ethers.parseEther('1000'));
	});

	describe('Trade with free bet', () => {
		it('Should fail with unsupported collateral', async () => {
			const sportsAMMV2Address = await sportsAMMV2.getAddress();
			await freeBetsHolder.addSupportedCollateral(collateralAddress, false, sportsAMMV2Address);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			expect(
				freeBetsHolder
					.connect(firstTrader)
					.trade(
						tradeDataCurrentRound,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						collateralAddress
					)
			).to.be.revertedWith('Unsupported collateral');
		});

		it('Set SportsAMM and LiveTradingProcessor', async () => {
			const sportsAMMAddress = await sportsAMMV2.getAddress();
			const liveTradingProcessorAddress = await liveTradingProcessor.getAddress();
			await freeBetsHolder.setSportsAMM(sportsAMMAddress);
			await freeBetsHolder.setLiveTradingProcessor(liveTradingProcessorAddress);

			const SportsAMMSet = await freeBetsHolder.sportsAMM();
			const LiveTradingSet = await freeBetsHolder.liveTradingProcessor();
			expect(SportsAMMSet).to.equal(sportsAMMAddress);
			expect(LiveTradingSet).to.equal(liveTradingProcessorAddress);
		});

		it('Should pass', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			await freeBetsHolder
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress
				);
		});

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
		});

		it('Should pass live', async () => {
			await sportsAMMV2RiskManager.setBatchLiveTradingPerSportAndTypeEnabled(
				[SPORT_ID_NBA],
				[0],
				true
			);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			await freeBetsHolder.connect(firstTrader).tradeLive({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: collateralAddress,
				_playerId: 0,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);
		});

		it('Should pass live parlay', async () => {
			const market0 = tradeDataTenMarketsCurrentRound[0];
			const market1 = tradeDataTenMarketsCurrentRound[1];
			const market2 = tradeDataTenMarketsCurrentRound[2];

			// Enable live trading for all three legs
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(market0.sportId, market0.typeId, true);
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(market1.sportId, market1.typeId, true);
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(market2.sportId, market2.typeId, true);

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			// Calculate approved quote from leg odds
			const ONE = 10n ** 18n;
			const mulWithDecimals = (a, b) => (a * b) / ONE;
			const leg0 = BigInt(market0.odds[market0.position]);
			const leg1 = BigInt(market1.odds[market1.position]);
			const leg2 = BigInt(market2.odds[market2.position]);
			const approvedLegOdds = [leg0, leg1, leg2];
			const approvedQuote = mulWithDecimals(mulWithDecimals(leg0, leg1), leg2);

			// Build parlay request
			const parlay = {
				legs: [
					{
						gameId: market0.gameId,
						sportId: market0.sportId,
						typeId: market0.typeId,
						line: market0.line,
						position: market0.position,
						expectedLegOdd: 0,
						playerId: 0,
					},
					{
						gameId: market1.gameId,
						sportId: market1.sportId,
						typeId: market1.typeId,
						line: market1.line,
						position: market1.position,
						expectedLegOdd: 0,
						playerId: 0,
					},
					{
						gameId: market2.gameId,
						sportId: market2.sportId,
						typeId: market2.typeId,
						line: market2.line,
						position: market2.position,
						expectedLegOdd: 0,
						playerId: 0,
					},
				],
				buyInAmount: BUY_IN_AMOUNT,
				expectedPayout: approvedQuote,
				additionalSlippage: ADDITIONAL_SLIPPAGE,
				referrer: ZERO_ADDRESS,
				collateral: collateralAddress,
			};

			// Call tradeLiveParlay
			const tx = await freeBetsHolder.connect(firstTrader).tradeLiveParlay(parlay);

			// Get the requestId after the transaction
			const requestId = await liveTradingProcessor.counterToRequestId(0);

			// Verify event emission
			await expect(tx)
				.to.emit(freeBetsHolder, 'FreeBetLiveParlayTradeRequested')
				.withArgs(firstTrader.address, BUY_IN_AMOUNT, requestId, 3);
			const userForRequest = await freeBetsHolder.liveRequestsPerUser(requestId);
			expect(userForRequest).to.equal(firstTrader.address);

			// Fulfill the live parlay trade
			await mockChainlinkOracle.fulfillLiveTradeParlay(requestId, true, approvedQuote, approvedLegOdds);

			// Verify ticket was created
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			expect(activeTickets.length).to.be.greaterThan(0);

			const ticketAddress = activeTickets[0];
			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.attach(ticketAddress);

			expect(await ticket.isLive()).to.eq(true);
			expect(await ticket.numOfMarkets()).to.eq(3);
			expect(await ticket.buyInAmount()).to.eq(BUY_IN_AMOUNT);

			// Verify ticket is linked to user via freeBetsHolder
			const ticketUser = await freeBetsHolder.ticketToUser(ticketAddress);
			expect(ticketUser).to.equal(firstTrader.address);

			// Verify user's free bet balance was deducted
			const firstTraderBalanceAfter = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfter).to.equal(ethers.parseEther('0'));

			// Verify active tickets per user
			const numActive = await freeBetsHolder.numOfActiveTicketsPerUser(firstTrader);
			expect(numActive).to.equal(1);
		});

		it('Should claim winnings', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			await freeBetsHolder
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress
				);

			const firstTraderBalanceAfterTrade = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfterTrade).to.equal(ethers.parseEther('0'));

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataCurrentRound[0].gameId],
				[tradeDataCurrentRound[0].typeId],
				[tradeDataCurrentRound[0].playerId],
				[[0]]
			);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// Get owner and collateral balances before resolution
			const freeBetsOwner = await freeBetsHolder.owner();
			const MockCollateral = await ethers.getContractFactory('ExoticUSD');
			const collateral = await MockCollateral.attach(collateralAddress);
			const ownerBalanceBefore = await collateral.balanceOf(freeBetsOwner);
			const userBalanceBefore = await collateral.balanceOf(firstTrader);

			await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

			// After resolution, user's free bet balance should remain 0
			const firstTraderBalanceAfterClaim = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfterClaim).to.equal(ethers.parseEther('0'));

			// Owner should receive the buy-in amount (10 ETH)
			const ownerBalanceAfter = await collateral.balanceOf(freeBetsOwner);
			expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ethers.parseEther('10'));

			// User should receive only the net winnings (20 - 10 = 10 ETH)
			const userBalanceAfter = await collateral.balanceOf(firstTrader);
			expect(userBalanceAfter).to.equal(userBalanceBefore + ethers.parseEther('10'));
		});

		it('Fund batch', async () => {
			await freeBetsHolder.fundBatch(
				[firstTrader, firstLiquidityProvider],
				collateralAddress,
				BUY_IN_AMOUNT
			);
		});

		it('User tickets hitory getters', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			await freeBetsHolder
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress
				);

			let numActive = await freeBetsHolder.numOfActiveTicketsPerUser(firstTrader);
			expect(numActive).to.equal(1);

			await freeBetsHolder.getActiveTicketsPerUser(0, 1, firstTrader);

			let numResolved = await freeBetsHolder.numOfResolvedTicketsPerUser(firstTrader);
			expect(numResolved).to.equal(0);

			await freeBetsHolder.getResolvedTicketsPerUser(0, 1, firstTrader);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const [, activeFreeBetsData] = await sportsAMMV2Data.getActiveTicketsDataPerUser(
				firstTrader,
				0,
				100
			);
			expect(activeFreeBetsData.length).to.be.equal(1);
			expect(activeFreeBetsData[0].id).to.be.equal(ticketAddress);

			const [, resolvedFreeBets] = await sportsAMMV2Data.getResolvedTicketsDataPerUser(
				firstTrader,
				0,
				100
			);
			expect(resolvedFreeBets.length).to.be.equal(0);
		});

		it('Should return full amount to user when ticket is cancelled', async () => {
			// Create a regular ticket with free bet
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await freeBetsHolder
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// Cancel the market/game
			const ticketMarket = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.cancelMarkets(
				[ticketMarket.gameId],
				[ticketMarket.typeId],
				[ticketMarket.playerId],
				[ticketMarket.line]
			);

			// Get balances before exercise
			const freeBetsOwner = await freeBetsHolder.owner();
			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			const ownerBalanceBefore = await collateral.balanceOf(freeBetsOwner);
			const freeBetBalanceBefore = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);

			// Check ticket state before exercise
			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.attach(ticketAddress);

			// Exercise the cancelled ticket
			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			// Check ticket state after exercise
			const finalPayout = await ticket.finalPayout();
			const buyInAmountFromTicket = await ticket.buyInAmount();
			const isCancelled = await ticket.cancelled();

			expect(isCancelled).to.equal(true);
			expect(finalPayout).to.equal(BUY_IN_AMOUNT);
			expect(buyInAmountFromTicket).to.equal(BUY_IN_AMOUNT);

			const userBalanceAfter = await collateral.balanceOf(firstTrader);
			const ownerBalanceAfter = await collateral.balanceOf(freeBetsOwner);
			const freeBetBalanceAfter = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);

			expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(0);
			expect(userBalanceAfter - userBalanceBefore).to.equal(0);
			expect(freeBetBalanceAfter - freeBetBalanceBefore).to.equal(BUY_IN_AMOUNT);

			const numActiveTickets = await freeBetsHolder.numOfActiveTicketsPerUser(firstTrader);
			const numResolvedTickets = await freeBetsHolder.numOfResolvedTicketsPerUser(firstTrader);
			expect(numActiveTickets).to.equal(0);
			expect(numResolvedTickets).to.equal(1);
		});
	});
});
