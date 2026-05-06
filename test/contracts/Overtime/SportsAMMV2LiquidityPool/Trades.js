const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { SPORTS_AMM_LP_INITAL_PARAMS } = require('../../../constants/overtimeContractParams');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	DEFAULT_AMOUNT,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
	SPORT_ID_NBA,
} = require('../../../constants/overtime');

describe('SportsAMMV2LiquidityPool Trades', () => {
	let sportsAMMV2,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		addressManager,
		sportsAMMV2LiquidityPoolRoundMastercopy,
		collateral,
		safeBox,
		owner,
		firstLiquidityProvider,
		firstTrader,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
			addressManager,
			sportsAMMV2LiquidityPoolRoundMastercopy,
			collateral,
			safeBox,
			tradeDataCurrentRound,
			tradeDataNextRound,
			tradeDataCrossRounds,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
			[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, TYPE_ID_WINNER_TOTAL],
			[
				RESULT_TYPE.ExactPosition,
				RESULT_TYPE.OverUnder,
				RESULT_TYPE.Spread,
				RESULT_TYPE.CombinedPositions,
			]
		);
	});

	const buildMarket = (tradeData) => ({
		gameId: tradeData.gameId,
		sportId: tradeData.sportId,
		typeId: tradeData.typeId,
		maturity: tradeData.maturity,
		status: tradeData.status,
		line: tradeData.line,
		playerId: tradeData.playerId,
		position: tradeData.position,
		odd: tradeData.odds[tradeData.position],
		combinedPositions: tradeData.combinedPositions[tradeData.position],
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

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
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
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
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
			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since there are no default round tickets)
			expect(await sportsAMMV2LiquidityPool.hasDefaultRoundTicketsReadyToBeExercised()).to.equal(
				false
			);

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

		it('Should be ticket in the current round (positive round)', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
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
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
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

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(ethers.parseEther('1009.8'));

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

			// check safe box profit on positive round
			const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			const diffSafeBoxBalance =
				ethers.formatEther(safeBoxBalanceAfterClose) -
				ethers.formatEther(safeBoxBalanceBeforeClose);

			const roundProfit =
				ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade);
			const safeBoxImpact = ethers.formatEther(await sportsAMMV2LiquidityPool.safeBoxImpact());

			expect(diffSafeBoxBalance).to.greaterThan(0);
			expect(diffSafeBoxBalance.toFixed(4)).to.equal((roundProfit * safeBoxImpact).toFixed(4));

			// check PnL
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound))
			);
			const roundProfitWithoutSafeBox = roundProfit * (1 - safeBoxImpact);
			const calculatedPnl =
				1 + roundProfitWithoutSafeBox / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

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
				(
					Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfitWithoutSafeBox
				).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(
					Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfitWithoutSafeBox
				).toFixed(4)
			);
		});

		it('Should be ticket in the next round (positive round)', async () => {
			const initialDeposit = ethers.parseEther('1000');
			const defaultLpAddress = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);

			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);
			let defaultLpBalanceBeforeTrade = await collateral.balanceOf(defaultLpAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			expect(defaultLpBalanceBeforeTrade).to.equal(DEFAULT_AMOUNT);

			// create a ticket for the next round - use defaul LP
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataNextRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataNextRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
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
			let defaultLpBalanceAfterTrade = await collateral.balanceOf(defaultLpAddress);

			const diffDefaultLpBalance =
				ethers.formatEther(defaultLpBalanceBeforeTrade) -
				ethers.formatEther(defaultLpBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(currentRoundPoolBalanceBeforeTrade);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffDefaultLpBalance.toFixed(4));

			// check next round data
			let nextRound = currentRound + 1;
			let nextRoundAllocation = await sportsAMMV2LiquidityPool.allocationPerRound(nextRound);
			expect(nextRoundAllocation).to.equal(ethers.parseEther('10.2'));
			let nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			expect(defaultLpBalanceBeforeTrade).to.not.equal(ZERO_ADDRESS);

			// get active ticket from Sports AMM
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check current round data on LP
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(0);

			// check ticket data in the next round on LP
			expect(await sportsAMMV2LiquidityPool.roundPerTicket(ticketAddress)).to.equal(nextRound);
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(nextRound);
			expect(await sportsAMMV2LiquidityPool.tradingTicketsPerRound(nextRound, 0)).to.equal(
				ticketAddress
			);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(nextRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(nextRound, ticketAddress)
			).to.equal(false);
			expect(await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(nextRound)).to.equal(
				1
			);
			expect(await sportsAMMV2LiquidityPool.getTicketPool(ticketAddress)).to.equal(
				nextRoundPoolAddress
			);

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);

			// increase time to round close time
			let currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			currentRound = Number(await sportsAMMV2LiquidityPool.round());
			currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundAllocation = await sportsAMMV2LiquidityPool.allocationPerRound(currentRound);
			expect(currentRoundAllocation).to.equal(ethers.parseEther('1010.2'));

			expect(currentRound).to.equal(3);

			// try exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataNextRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(ethers.parseEther('1020'));

			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			// check safe box profit on positive round
			const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			const diffSafeBoxBalance =
				ethers.formatEther(safeBoxBalanceAfterClose) -
				ethers.formatEther(safeBoxBalanceBeforeClose);

			const roundProfit =
				ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
				ethers.formatEther(currentRoundAllocation);
			const safeBoxImpact = ethers.formatEther(await sportsAMMV2LiquidityPool.safeBoxImpact());

			expect(diffSafeBoxBalance).to.greaterThan(0);
			expect(diffSafeBoxBalance.toFixed(4)).to.equal((roundProfit * safeBoxImpact).toFixed(4));

			// check PnL
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound))
			);
			const cumulativePnLBetweenRounds = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativePnLBetweenRounds(3, 2))
			);
			const roundProfitWithoutSafeBox = roundProfit * (1 - safeBoxImpact);
			const calculatedPnl =
				1 + roundProfitWithoutSafeBox / ethers.formatEther(currentRoundAllocation);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(cumulativePnLBetweenRounds).to.equal(1);

			// check default LP balance
			const calculatedDefaultLpProfit = diffDefaultLpBalance * (currentRoundPnl - 1);
			let defaultLpBalanceAfterWithdrawal = await collateral.balanceOf(defaultLpAddress);
			let defaultLpProfit =
				ethers.formatEther(defaultLpBalanceAfterWithdrawal) -
				ethers.formatEther(defaultLpBalanceBeforeTrade);
			expect(defaultLpProfit.toFixed(8)).to.equal(calculatedDefaultLpProfit.toFixed(8));

			// check next round data
			nextRound = await sportsAMMV2LiquidityPool.round();
			expect(nextRound).to.equal(4);
			nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))
			);
			nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound))
			);
			const caclucaltedNextRoundAllocation =
				Number(ethers.formatEther(currentRoundAllocation)) +
				roundProfitWithoutSafeBox -
				diffDefaultLpBalance * currentRoundPnl;

			expect(nextRoundPoolBalance.toFixed(8)).to.equal(caclucaltedNextRoundAllocation.toFixed(8));
			expect(nextRoundAllocation.toFixed(8)).to.equal(caclucaltedNextRoundAllocation.toFixed(8));
		});

		it('Should be ticket in the round 1 (cross rounds)', async () => {
			const initialDeposit = ethers.parseEther('1000');
			const defaultLpAddress = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);

			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);
			let defaultLpBalanceBeforeTrade = await collateral.balanceOf(defaultLpAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			expect(defaultLpBalanceBeforeTrade).to.equal(DEFAULT_AMOUNT);

			// create a ticket for cross rounds - use defaul LP
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCrossRounds,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCrossRounds,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// In deferred mode, LP receives buyIn at trade creation (not fronts the payout diff).
			// payout: 40, fees: 0.2, buy-in: 10
			// defaultLP gains buyIn (10) at creation, pays payout+fees at resolution.
			let currentRoundPoolBalanceAfterTrade = await collateral.balanceOf(currentRoundPoolAddress);
			let defaultLpBalanceAfterTrade = await collateral.balanceOf(defaultLpAddress);

			const diffDefaultLpBalance =
				ethers.formatEther(defaultLpBalanceBeforeTrade) -
				ethers.formatEther(defaultLpBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(currentRoundPoolBalanceBeforeTrade);
			// Deferred: LP received buyIn → balance went UP, so diff is negative (−buyIn)
			expect(diffDefaultLpBalance.toFixed(4)).to.equal(
				(-Number(ethers.formatEther(BUY_IN_AMOUNT))).toFixed(4)
			);

			// check default round data
			const defaultRound = 1;
			let defaultRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(defaultRound))
			);
			let defaultRoundAddress = await sportsAMMV2LiquidityPool.roundPools(defaultRound);
			// Deferred: commitTradeDeferred does not update allocationPerRound[1]
			expect(defaultRoundAllocation).to.equal(0);
			expect(defaultRoundAddress).to.equal(defaultLpAddress);

			// get active Ticket from Sports AMM
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check current round data on LP
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(0);

			// check ticket data in the default round on LP
			expect(await sportsAMMV2LiquidityPool.roundPerTicket(ticketAddress)).to.equal(defaultRound);
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(defaultRound);
			expect(await sportsAMMV2LiquidityPool.tradingTicketsPerRound(defaultRound, 0)).to.equal(
				ticketAddress
			);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(defaultRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(defaultRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(defaultRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPool.getTicketPool(ticketAddress)).to.equal(
				defaultRoundAddress
			);

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();

			// increase time to round close time
			let currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			currentRound = Number(await sportsAMMV2LiquidityPool.round());
			currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundAllocation = await sportsAMMV2LiquidityPool.allocationPerRound(currentRound);
			expect(currentRoundAllocation).to.equal(initialDeposit);

			expect(currentRound).to.equal(3);

			// try exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCrossRounds[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);
			const ticketMarket2 = tradeDataCrossRounds[1];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket2.gameId],
				[ticketMarket2.typeId],
				[ticketMarket2.playerId],
				[[1000]]
			);
			// try exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(initialDeposit);

			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			// check safe box profit
			const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			const diffSafeBoxBalance =
				ethers.formatEther(safeBoxBalanceAfterClose) -
				ethers.formatEther(safeBoxBalanceBeforeClose);

			const roundProfit =
				ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(diffSafeBoxBalance).to.equal(0);
			expect(roundProfit).to.equal(0);

			// check PnL
			const currentRoundPnl = await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound);
			const currentRoundCumulativePnl =
				await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound);
			const cumulativePnLBetweenRounds = await sportsAMMV2LiquidityPool.cumulativePnLBetweenRounds(
				3,
				2
			);

			expect(currentRoundPnl).to.equal(ethers.parseEther('1'));
			expect(currentRoundCumulativePnl).to.equal(ethers.parseEther('1'));
			expect(cumulativePnLBetweenRounds).to.equal(ethers.parseEther('1'));

			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPool.round();
			expect(nextRound).to.equal(4);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);

			expect(await collateral.balanceOf(nextRoundPoolAddress)).to.equal(initialDeposit);
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound)).to.equal(initialDeposit);

			// check default LP balance
			let defaultLpBalanceAfterExercise = await collateral.balanceOf(defaultLpAddress);
			let defaultLpProfit =
				ethers.formatEther(defaultLpBalanceAfterExercise) -
				ethers.formatEther(defaultLpBalanceBeforeTrade);
			let buyInAmountAfterFees = ethers.formatEther(BUY_IN_AMOUNT) - ethers.formatEther(quote.fees);
			expect(defaultLpProfit.toFixed(8)).to.equal(Number(buyInAmountAfterFees).toFixed(8));

			expect(await sportsAMMV2LiquidityPool.hasDefaultRoundTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPool.exerciseDefaultRoundTicketsReadyToBeExercisedBatch(1);
			await sportsAMMV2LiquidityPool.exerciseDefaultRoundTicketsReadyToBeExercised();
			let defaultLpBalanceAfterExerciseDefaultRound = await collateral.balanceOf(defaultLpAddress);
		});

		it('Should be ticket in the current round (positive round)', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
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
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
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

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(ethers.parseEther('1009.8'));

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

			// check safe box profit on positive round
			const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			const diffSafeBoxBalance =
				ethers.formatEther(safeBoxBalanceAfterClose) -
				ethers.formatEther(safeBoxBalanceBeforeClose);

			const roundProfit =
				ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade);
			const safeBoxImpact = ethers.formatEther(await sportsAMMV2LiquidityPool.safeBoxImpact());

			expect(diffSafeBoxBalance).to.greaterThan(0);
			expect(diffSafeBoxBalance.toFixed(4)).to.equal((roundProfit * safeBoxImpact).toFixed(4));

			// check PnL
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound))
			);
			const roundProfitWithoutSafeBox = roundProfit * (1 - safeBoxImpact);
			const calculatedPnl =
				1 + roundProfitWithoutSafeBox / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

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
				(
					Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfitWithoutSafeBox
				).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(
					Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfitWithoutSafeBox
				).toFixed(4)
			);
		});

		it('Should be ticket in the next round (positive round)', async () => {
			const initialDeposit = ethers.parseEther('1000');
			const defaultLpAddress = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);

			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);
			let defaultLpBalanceBeforeTrade = await collateral.balanceOf(defaultLpAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			expect(defaultLpBalanceBeforeTrade).to.equal(DEFAULT_AMOUNT);

			// create a ticket for the next round - use defaul LP
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataNextRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataNextRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
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
			let defaultLpBalanceAfterTrade = await collateral.balanceOf(defaultLpAddress);

			const diffDefaultLpBalance =
				ethers.formatEther(defaultLpBalanceBeforeTrade) -
				ethers.formatEther(defaultLpBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(currentRoundPoolBalanceBeforeTrade);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffDefaultLpBalance.toFixed(4));

			// check next round data
			let nextRound = currentRound + 1;
			let nextRoundAllocation = await sportsAMMV2LiquidityPool.allocationPerRound(nextRound);
			expect(nextRoundAllocation).to.equal(ethers.parseEther('10.2'));
			let nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			expect(defaultLpBalanceBeforeTrade).to.not.equal(ZERO_ADDRESS);

			// get active ticket from Sports AMM
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check current round data on LP
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(0);

			// check ticket data in the next round on LP
			expect(await sportsAMMV2LiquidityPool.roundPerTicket(ticketAddress)).to.equal(nextRound);
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(nextRound);
			expect(await sportsAMMV2LiquidityPool.tradingTicketsPerRound(nextRound, 0)).to.equal(
				ticketAddress
			);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(nextRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(nextRound, ticketAddress)
			).to.equal(false);
			expect(await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(nextRound)).to.equal(
				1
			);
			expect(await sportsAMMV2LiquidityPool.getTicketPool(ticketAddress)).to.equal(
				nextRoundPoolAddress
			);

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);

			// increase time to round close time
			let currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			currentRound = Number(await sportsAMMV2LiquidityPool.round());
			currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundAllocation = await sportsAMMV2LiquidityPool.allocationPerRound(currentRound);
			expect(currentRoundAllocation).to.equal(ethers.parseEther('1010.2'));

			expect(currentRound).to.equal(3);

			// try exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataNextRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(ethers.parseEther('1020'));

			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			// check safe box profit on positive round
			const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			const diffSafeBoxBalance =
				ethers.formatEther(safeBoxBalanceAfterClose) -
				ethers.formatEther(safeBoxBalanceBeforeClose);

			const roundProfit =
				ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
				ethers.formatEther(currentRoundAllocation);
			const safeBoxImpact = ethers.formatEther(await sportsAMMV2LiquidityPool.safeBoxImpact());

			expect(diffSafeBoxBalance).to.greaterThan(0);
			expect(diffSafeBoxBalance.toFixed(4)).to.equal((roundProfit * safeBoxImpact).toFixed(4));

			// check PnL
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound))
			);
			const cumulativePnLBetweenRounds = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativePnLBetweenRounds(3, 2))
			);
			const roundProfitWithoutSafeBox = roundProfit * (1 - safeBoxImpact);
			const calculatedPnl =
				1 + roundProfitWithoutSafeBox / ethers.formatEther(currentRoundAllocation);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(cumulativePnLBetweenRounds).to.equal(1);

			// check default LP balance
			const calculatedDefaultLpProfit = diffDefaultLpBalance * (currentRoundPnl - 1);
			let defaultLpBalanceAfterWithdrawal = await collateral.balanceOf(defaultLpAddress);
			let defaultLpProfit =
				ethers.formatEther(defaultLpBalanceAfterWithdrawal) -
				ethers.formatEther(defaultLpBalanceBeforeTrade);
			expect(defaultLpProfit.toFixed(8)).to.equal(calculatedDefaultLpProfit.toFixed(8));

			// check next round data
			nextRound = await sportsAMMV2LiquidityPool.round();
			expect(nextRound).to.equal(4);
			nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))
			);
			nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound))
			);
			const caclucaltedNextRoundAllocation =
				Number(ethers.formatEther(currentRoundAllocation)) +
				roundProfitWithoutSafeBox -
				diffDefaultLpBalance * currentRoundPnl;

			expect(nextRoundPoolBalance.toFixed(8)).to.equal(caclucaltedNextRoundAllocation.toFixed(8));
			expect(nextRoundAllocation.toFixed(8)).to.equal(caclucaltedNextRoundAllocation.toFixed(8));
		});

		it('Exercise batch default round ticket', async () => {
			const initialDeposit = ethers.parseEther('1000');
			const defaultLpAddress = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let defaultLpBalanceBeforeTrade = await collateral.balanceOf(defaultLpAddress);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCrossRounds,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCrossRounds,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// difference between payout and buy-in (amount taken from LP)
			// payout: 40
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 30.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT));

			// increase time to round close time
			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCrossRounds[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);
			const ticketMarket2 = tradeDataCrossRounds[1];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket2.gameId],
				[ticketMarket2.typeId],
				[ticketMarket2.playerId],
				[[1000]]
			);

			await sportsAMMV2LiquidityPool.exerciseDefaultRoundTicketsReadyToBeExercisedBatch(1);

			// check default LP balance
			let defaultLpBalanceAfterExercise = await collateral.balanceOf(defaultLpAddress);
			let defaultLpProfit =
				ethers.formatEther(defaultLpBalanceAfterExercise) -
				ethers.formatEther(defaultLpBalanceBeforeTrade);
			let buyInAmountAfterFees = ethers.formatEther(BUY_IN_AMOUNT) - ethers.formatEther(quote.fees);
			expect(defaultLpProfit.toFixed(8)).to.equal(Number(buyInAmountAfterFees).toFixed(8));
		});
		it('Exercise default round ticket', async () => {
			const initialDeposit = ethers.parseEther('1000');
			const defaultLpAddress = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let defaultLpBalanceBeforeTrade = await collateral.balanceOf(defaultLpAddress);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCrossRounds,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCrossRounds,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// difference between payout and buy-in (amount taken from LP)
			// payout: 40
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 30.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT));

			// increase time to round close time
			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCrossRounds[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);
			const ticketMarket2 = tradeDataCrossRounds[1];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket2.gameId],
				[ticketMarket2.typeId],
				[ticketMarket2.playerId],
				[[1000]]
			);

			await sportsAMMV2LiquidityPool.exerciseDefaultRoundTicketsReadyToBeExercised();

			// check default LP balance
			let defaultLpBalanceAfterExercise = await collateral.balanceOf(defaultLpAddress);
			let defaultLpProfit =
				ethers.formatEther(defaultLpBalanceAfterExercise) -
				ethers.formatEther(defaultLpBalanceBeforeTrade);
			let buyInAmountAfterFees = ethers.formatEther(BUY_IN_AMOUNT) - ethers.formatEther(quote.fees);
			expect(defaultLpProfit.toFixed(8)).to.equal(Number(buyInAmountAfterFees).toFixed(8));
		});

		it('Futures are always in round 1', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2RiskManager.setIsSportIdFuture(SPORT_ID_NBA, true);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPool.roundPerTicket(ticketAddress)).to.equal(1);
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(1);
			expect(await sportsAMMV2LiquidityPool.tradingTicketsPerRound(1, 0)).to.equal(ticketAddress);
		});
	});

	describe('defaultRoundHighQuoteThreshold', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('feature disabled by default - high-quote parlay stays in current round', async () => {
			const initialDeposit = ethers.parseEther('1000');
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			// threshold defaults to 0 - feature disabled
			expect(await sportsAMMV2RiskManager.defaultRoundHighQuoteThreshold()).to.equal(0);

			const currentRound = Number(await sportsAMMV2LiquidityPool.round());
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
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
					false
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// Despite being a high-quote parlay, threshold=0 means no special routing
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(currentRound);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(true);
		});

		it('high-quote multi-leg ticket routed to default round when threshold is set', async () => {
			const initialDeposit = ethers.parseEther('1000');
			const defaultLpAddress = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			const currentRound = Number(await sportsAMMV2LiquidityPool.round());
			const defaultRound = 1;

			// Get the actual totalQuote of the 10-leg parlay
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			// Set threshold just above the actual quote so totalQuote < threshold → deferred routing
			const threshold = quote.totalQuote + 1n;
			await sportsAMMV2RiskManager.setDefaultRoundHighQuoteThreshold(threshold);
			expect(await sportsAMMV2RiskManager.defaultRoundHighQuoteThreshold()).to.equal(threshold);

			const defaultLpBalanceBefore = await collateral.balanceOf(defaultLpAddress);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// ticket must be in the default round (1), NOT the current round
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(defaultRound);
			expect(await sportsAMMV2LiquidityPool.roundPerTicket(ticketAddress)).to.equal(defaultRound);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(defaultRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(false);

			// deferred mode: LP received buyIn so its balance went UP by buyIn
			const defaultLpBalanceAfter = await collateral.balanceOf(defaultLpAddress);
			expect(defaultLpBalanceAfter - defaultLpBalanceBefore).to.equal(BUY_IN_AMOUNT);

			// current-round pool is untouched
			const currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			expect(await collateral.balanceOf(currentRoundPoolAddress)).to.equal(initialDeposit);
		});

		it('single-leg ticket not routed to default round even with threshold above its quote', async () => {
			const initialDeposit = ethers.parseEther('1000');
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			const currentRound = Number(await sportsAMMV2LiquidityPool.round());
			const defaultRound = 1;

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			// Set threshold above the single-leg quote so the quote check alone would trigger,
			// but numOfMarkets = 1 so the routing must NOT apply
			const threshold = quote.totalQuote + 1n;
			await sportsAMMV2RiskManager.setDefaultRoundHighQuoteThreshold(threshold);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// single-leg: numOfMarkets = 1, so routing guard is not triggered
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(currentRound);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(defaultRound, ticketAddress)
			).to.equal(false);
		});

		it('multi-leg ticket stays in current round when its quote equals the threshold', async () => {
			const initialDeposit = ethers.parseEther('1000');
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			const currentRound = Number(await sportsAMMV2LiquidityPool.round());

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			// threshold == totalQuote: condition is totalQuote < threshold (strict), so NOT triggered
			await sportsAMMV2RiskManager.setDefaultRoundHighQuoteThreshold(quote.totalQuote);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// quote == threshold → strict less-than fails → ticket stays in current round
			expect(await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress)).to.equal(currentRound);
			expect(
				await sportsAMMV2LiquidityPool.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(true);
		});
	});

	describe('LP error branches', () => {
		const deployLpWithoutDefault = async () => {
			const SportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
			const lp = await upgrades.deployProxy(SportsAMMV2LiquidityPool, [
				{
					_owner: owner.address,
					_sportsAMM: owner.address,
					_addressManager: await addressManager.getAddress(),
					_collateral: await collateral.getAddress(),
					_collateralKey: ethers.encodeBytes32String('SUSD'),
					_roundLength: SPORTS_AMM_LP_INITAL_PARAMS.roundLength,
					_maxAllowedDeposit: SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedDeposit,
					_minDepositAmount: SPORTS_AMM_LP_INITAL_PARAMS.minDepositAmount,
					_maxAllowedUsers: SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedUsers,
					_utilizationRate: SPORTS_AMM_LP_INITAL_PARAMS.utilizationRate,
					_safeBox: safeBox.address,
					_safeBoxImpact: SPORTS_AMM_LP_INITAL_PARAMS.safeBoxImpact,
				},
			]);

			await lp.setPoolRoundMastercopy(await sportsAMMV2LiquidityPoolRoundMastercopy.getAddress());
			return lp;
		};

		it('commitTrade reverts DefaultLPNotSet when default LP is missing', async () => {
			const lp = await deployLpWithoutDefault();
			const initialDeposit = ethers.parseEther('1000');

			await collateral.connect(firstLiquidityProvider).approve(lp, initialDeposit);
			await lp.connect(firstLiquidityProvider).deposit(initialDeposit);
			await lp.start();

			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.deploy();
			const market = buildMarket(tradeDataNextRound[0]);

			await ticket.initialize({
				_markets: [market],
				_buyInAmount: BUY_IN_AMOUNT,
				_fees: 0,
				_totalQuote: 0,
				_sportsAMM: owner.address,
				_ticketOwner: firstTrader.address,
				_collateral: await collateral.getAddress(),
				_expiry: BigInt(market.maturity) + 1n,
				_isLive: false,
				_systemBetDenominator: 0,
				_isSGP: false,
			});

			await expect(
				lp.connect(owner).commitTrade(ticket.target, BUY_IN_AMOUNT)
			).to.be.revertedWithCustomError(lp, 'DefaultLPNotSet');
		});

		it('commitTrade reverts DefaultLPNotSet for default-round ticket', async () => {
			const lp = await deployLpWithoutDefault();
			const initialDeposit = ethers.parseEther('1000');

			await collateral.connect(firstLiquidityProvider).approve(lp, initialDeposit);
			await lp.connect(firstLiquidityProvider).deposit(initialDeposit);
			await lp.start();

			const firstRoundStartTime = Number(await lp.firstRoundStartTime());
			const roundLength = Number(await lp.roundLength());
			const market1 = buildMarket(tradeDataCrossRounds[0]);
			const market2 = buildMarket(tradeDataCrossRounds[1]);
			market1.maturity = firstRoundStartTime + roundLength;
			market2.maturity = firstRoundStartTime + roundLength * 2;
			const expiry = BigInt(Math.max(market1.maturity, market2.maturity)) + 1n;

			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.deploy();

			await ticket.initialize({
				_markets: [market1, market2],
				_buyInAmount: BUY_IN_AMOUNT,
				_fees: 0,
				_totalQuote: 0,
				_sportsAMM: owner.address,
				_ticketOwner: firstTrader.address,
				_collateral: await collateral.getAddress(),
				_expiry: expiry,
				_isLive: false,
				_systemBetDenominator: 0,
				_isSGP: false,
			});

			expect(await lp.getTicketRound(ticket.target)).to.equal(1);

			await expect(
				lp.connect(owner).commitTrade(ticket.target, BUY_IN_AMOUNT)
			).to.be.revertedWithCustomError(lp, 'DefaultLPNotSet');
		});

		it('commitTrade reverts InvalidRound when ticketRound is behind and not default', async () => {
			const lp = await deployLpWithoutDefault();
			const initialDeposit = ethers.parseEther('1000');

			await collateral.connect(firstLiquidityProvider).approve(lp, initialDeposit);
			await lp.connect(firstLiquidityProvider).deposit(initialDeposit);
			await lp.start();

			const roundEndTime = await lp.getRoundEndTime(2);
			await time.increaseTo(roundEndTime);
			await lp.prepareRoundClosing();
			await lp.processRoundClosingBatch(10);
			await lp.closeRound();

			const TicketContract = await ethers.getContractFactory('Ticket');
			const ticket = await TicketContract.deploy();
			const market = buildMarket(tradeDataCurrentRound[0]);

			await ticket.initialize({
				_markets: [market],
				_buyInAmount: BUY_IN_AMOUNT,
				_fees: 0,
				_totalQuote: 0,
				_sportsAMM: owner.address,
				_ticketOwner: firstTrader.address,
				_collateral: await collateral.getAddress(),
				_expiry: BigInt(market.maturity) + 1n,
				_isLive: false,
				_systemBetDenominator: 0,
				_isSGP: false,
			});

			await expect(
				lp.connect(owner).commitTrade(ticket.target, BUY_IN_AMOUNT)
			).to.be.revertedWithCustomError(lp, 'InvalidRound');
		});
	});
});
