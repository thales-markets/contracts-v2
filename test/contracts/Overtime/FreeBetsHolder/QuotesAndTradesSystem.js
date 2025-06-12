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
		await collateral.connect(firstLiquidityProvider).approve(freeBetsHolder.target, ethers.parseEther('1000'));
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

			// Get owner and collateral balances before resolution
			const freeBetsOwner = await freeBetsHolder.owner();
			const MockCollateral = await ethers.getContractFactory('ExoticUSD');
			const collateral = await MockCollateral.attach(collateralAddress);
			const ownerBalanceBefore = await collateral.balanceOf(freeBetsOwner);

			await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);
			const firstTraderBalanceAfter = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			// User's free bet balance should remain 0
			expect(firstTraderBalanceAfter).to.be.greaterThan(0);
			expect(firstTraderBalanceAfter).to.be.lessThan(BUY_IN_AMOUNT);

			// Owner should receive the payout amount (4.000914494741655190 ETH)
			const ownerBalanceAfter = await collateral.balanceOf(freeBetsOwner);
			expect(ownerBalanceAfter).to.equal(
				ownerBalanceBefore
			);
		});
		it('Should handle winning system bet correctly', async () => {
			// Set result types for the markets
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, 11029],
				[
					RESULT_TYPE.ExactPosition,
					RESULT_TYPE.OverUnder,
					RESULT_TYPE.Spread,
					RESULT_TYPE.OverUnder,
				]
			);

			// Create a system bet (3 out of 10)
			const systemBetDenominator = 3;
			const quote = await sportsAMMV2.tradeQuoteSystem(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				collateralAddress,
				false,
				systemBetDenominator
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
					systemBetDenominator
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// Set results - make 3 markets win
			for (let i = 0; i < 3; i++) {
				await sportsAMMV2ResultManager.setResultsPerMarkets(
					[tradeDataTenMarketsCurrentRound[i].gameId],
					[tradeDataTenMarketsCurrentRound[i].typeId],
					[tradeDataTenMarketsCurrentRound[i].playerId],
					[[tradeDataTenMarketsCurrentRound[i].position]]
				);
			}

			// Set remaining markets as lost
			for (let i = 3; i < 10; i++) {
				await sportsAMMV2ResultManager.setResultsPerMarkets(
					[tradeDataTenMarketsCurrentRound[i].gameId],
					[tradeDataTenMarketsCurrentRound[i].typeId],
					[tradeDataTenMarketsCurrentRound[i].playerId],
					[[1 - tradeDataTenMarketsCurrentRound[i].position]]
				);
			}

			// Get balances before exercise
			const freeBetsOwner = await freeBetsHolder.owner();
			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			const ownerBalanceBefore = await collateral.balanceOf(freeBetsOwner);

			// Check ticket before exercise
			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.attach(ticketAddress);
			
			// Exercise the system bet ticket
			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			// Check ticket state after exercise
			const finalPayout = await ticket.finalPayout();
			const buyInAmountFromTicket = await ticket.buyInAmount();
			
			// Get balances after exercise
			const userBalanceAfter = await collateral.balanceOf(firstTrader);
			const ownerBalanceAfter = await collateral.balanceOf(freeBetsOwner);

			// For winning system bet:
			// If payout > buyInAmount: buyInAmount goes to owner, profit to user
			// If payout <= buyInAmount: all goes to user
			const ownerReceived = ownerBalanceAfter - ownerBalanceBefore;
			const userReceived = userBalanceAfter - userBalanceBefore;
			
			if (finalPayout >= buyInAmountFromTicket) {
				// Owner should receive the buyInAmount
				expect(ownerReceived).to.equal(BUY_IN_AMOUNT);
				// User should receive profit
				expect(userReceived).to.equal(finalPayout - buyInAmountFromTicket);
			} else {
				// If payout < buyInAmount, all goes to user
				expect(ownerReceived).to.equal(0);
				expect(userReceived).to.equal(finalPayout);
			}
		});

		it('Should handle cancelled system bet correctly', async () => {
			const systemBetDenominator = 3;
			const quote = await sportsAMMV2.tradeQuoteSystem(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				collateralAddress,
				false,
				systemBetDenominator
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
					systemBetDenominator
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// Cancel all markets in the system bet
			for (let i = 0; i < 10; i++) {
				const market = tradeDataTenMarketsCurrentRound[i];
				await sportsAMMV2ResultManager.cancelMarkets(
					[market.gameId],
					[market.typeId],
					[market.playerId],
					[market.line]
				);
			}

			// Get balances before exercise
			const userBalanceBefore = await collateral.balanceOf(firstTrader);

			// Exercise the cancelled system bet
			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			// Get balances after exercise
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			// For cancelled system bet, full buyInAmount should go to user
			expect(userBalanceAfter - userBalanceBefore).to.equal(BUY_IN_AMOUNT);
		});

		it('Should handle partially cancelled system bet correctly (2 games cancelled)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, 11029],
				[
					RESULT_TYPE.ExactPosition,
					RESULT_TYPE.OverUnder,
					RESULT_TYPE.Spread,
					RESULT_TYPE.OverUnder,
				]
			);

			const systemBetDenominator = 3;
			const quote = await sportsAMMV2.tradeQuoteSystem(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				collateralAddress,
				false,
				systemBetDenominator
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
					systemBetDenominator
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// Cancel only 2 markets
			for (let i = 0; i < 2; i++) {
				const market = tradeDataTenMarketsCurrentRound[i];
				await sportsAMMV2ResultManager.cancelMarkets(
					[market.gameId],
					[market.typeId],
					[market.playerId],
					[market.line]
				);
			}

			// Set results for remaining markets - make some win, some lose
			// Markets 2-4: Win (3 winning markets)
			for (let i = 2; i < 5; i++) {
				await sportsAMMV2ResultManager.setResultsPerMarkets(
					[tradeDataTenMarketsCurrentRound[i].gameId],
					[tradeDataTenMarketsCurrentRound[i].typeId],
					[tradeDataTenMarketsCurrentRound[i].playerId],
					[[tradeDataTenMarketsCurrentRound[i].position]]
				);
			}

			// Markets 5-9: Lose
			for (let i = 5; i < 10; i++) {
				await sportsAMMV2ResultManager.setResultsPerMarkets(
					[tradeDataTenMarketsCurrentRound[i].gameId],
					[tradeDataTenMarketsCurrentRound[i].typeId],
					[tradeDataTenMarketsCurrentRound[i].playerId],
					[[1 - tradeDataTenMarketsCurrentRound[i].position]]
				);
			}

			// Get balances before exercise
			const freeBetsOwner = await freeBetsHolder.owner();
			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			const ownerBalanceBefore = await collateral.balanceOf(freeBetsOwner);
			const freeBetBalanceBefore = await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress);

			// Check ticket before exercise
			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.attach(ticketAddress);

			// Exercise the partially cancelled system bet
			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			// Check ticket state after exercise
			const finalPayout = await ticket.finalPayout();
			const buyInAmountFromTicket = await ticket.buyInAmount();
			const isCancelled = await ticket.cancelled();

			// Get balances after exercise
			const userBalanceAfter = await collateral.balanceOf(firstTrader);
			const ownerBalanceAfter = await collateral.balanceOf(freeBetsOwner);
			const freeBetBalanceAfter = await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress);

			// The ticket should not be fully cancelled (isCancelled = false)
			expect(isCancelled).to.equal(false);

			const ownerReceived = ownerBalanceAfter - ownerBalanceBefore;
			const userReceived = userBalanceAfter - userBalanceBefore;
			const freeBetReceived = freeBetBalanceAfter - freeBetBalanceBefore;

			expect(ownerReceived).to.equal(0);
			expect(userReceived).to.equal(finalPayout);
			expect(freeBetReceived).to.equal(finalPayout);
		});
	});
});
