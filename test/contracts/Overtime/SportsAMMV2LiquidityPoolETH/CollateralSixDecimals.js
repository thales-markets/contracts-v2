const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');
const {
	BUY_IN_AMOUNT,
	BUY_IN_AMOUNT_SIX_DECIMALS,
	ADDITIONAL_SLIPPAGE,
	DEFAULT_AMOUNT,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
} = require('../../../constants/overtime');

describe('SportsAMMV2LiquidityPool Trades', () => {
	let sportsAMMV2,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		collateral,
		collateralSixDecimals,
		multiCollateral,
		safeBox,
		firstLiquidityProvider,
		firstTrader,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			collateral,
			collateralSixDecimals,
			multiCollateral,
			safeBox,
			tradeDataCurrentRound,
			tradeDataNextRound,
			tradeDataCrossRounds,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
			[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, TYPE_ID_WINNER_TOTAL],
			[
				RESULT_TYPE.ExactPosition,
				RESULT_TYPE.OverUnder,
				RESULT_TYPE.OverUnder,
				RESULT_TYPE.CombinedPositions,
			]
		);
	});

	describe('Trades', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('Should be ticket in the current round (negative round)', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			let multiCollateralMinimumNeeded = await multiCollateral.getMinimumNeeded(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT
			);
			console.log('multiCollateralMinimumNeeded: ', multiCollateralMinimumNeeded.toString());
			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// create a ticket
			const quote1 = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralSixDecimals
			);
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);
			console.log('quote1: ', quote1.payout.toString());
			console.log('quote: ', quote.payout.toString());
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote1.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals
				);

			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT));

			let currentRoundPoolBalanceAfterTrade = await collateral.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(ethers.parseEther('989.8'));
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPool.roundPerTicket(ticketAddress)).to.equal(currentRound);
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(currentRound);
			expect(await sportsAMMV2LiquidityPool.tradingTicketsPerRound(currentRound, 0)).to.equal(
				ticketAddress
			);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPool.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPool.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPool.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			const diffSafeBoxBalance =
				ethers.formatEther(safeBoxBalanceAfterClose) -
				ethers.formatEther(safeBoxBalanceBeforeClose);

			const roundProfit =
				ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(diffSafeBoxBalance).to.equal(0);
			expect(roundProfit).to.lessThan(0);

			// check PnL
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound))
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPool.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});
	});
});