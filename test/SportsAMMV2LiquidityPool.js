const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('./constants/general');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, DEFAULT_AMOUNT } = require('./constants/overtime');

describe('SportsAMMV2LiquidityPool', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolRoundMastercopy,
		defaultLiquidityProvider,
		collateral,
		stakingThales,
		safeBox,
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		firstLiquidityProvider,
		secondLiquidityProvider,
		thirdLiquidityProvider,
		firstTrader,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds;

	beforeEach(async () => {
		const sportsAMMV2Fixture = await loadFixture(deploySportsAMMV2Fixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		sportsAMMV2 = sportsAMMV2Fixture.sportsAMMV2;
		sportsAMMV2LiquidityPool = sportsAMMV2Fixture.sportsAMMV2LiquidityPool;
		sportsAMMV2LiquidityPoolRoundMastercopy =
			sportsAMMV2Fixture.sportsAMMV2LiquidityPoolRoundMastercopy;
		defaultLiquidityProvider = sportsAMMV2Fixture.defaultLiquidityProvider;
		collateral = sportsAMMV2Fixture.collateral;
		stakingThales = sportsAMMV2Fixture.stakingThales;
		safeBox = sportsAMMV2Fixture.safeBox;
		owner = sportsAMMV2Fixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
		fourthAccount = accountsFixture.fourthAccount;
		firstLiquidityProvider = accountsFixture.firstLiquidityProvider;
		secondLiquidityProvider = accountsFixture.secondLiquidityProvider;
		thirdLiquidityProvider = accountsFixture.thirdLiquidityProvider;
		firstTrader = accountsFixture.firstTrader;

		tradeDataCurrentRound = sportsAMMV2Fixture.tradeDataCurrentRound;
		tradeDataNextRound = sportsAMMV2Fixture.tradeDataNextRound;
		tradeDataCrossRounds = sportsAMMV2Fixture.tradeDataCrossRounds;
	});

	describe('Trades', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider,
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider,
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(secondLiquidityProvider);
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(thirdLiquidityProvider);
		});

		it('Should be negative round - ticket in the current round', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// difference between payout and buy-in (amount taken from LP)
			// buy-in without fees: 9.8
			// payout: 20
			// diff taken from LP: 10.8
			const diffPayoutBuyIn =
				ethers.formatEther(quote.payout) - ethers.formatEther(quote.buyInAmountAfterFees);

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

			// resolve ticket game as winning for the user
			const ticketGame1 = tradeDataCurrentRound[0];
			await sportsAMMV2.setScoreForGame(
				ticketGame1.gameId,
				ticketGame1.playerPropsId,
				ticketGame1.playerId,
				123,
				100
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

		it('Should be positive round - ticket in the current round', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// difference between payout and buy-in (amount taken from LP)
			// buy-in without fees: 9.8
			// payout: 20
			// diff taken from LP: 10.8
			const diffPayoutBuyIn =
				ethers.formatEther(quote.payout) - ethers.formatEther(quote.buyInAmountAfterFees);

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

			// resolve ticket game as loss for the user
			const ticketGame1 = tradeDataCurrentRound[0];
			await sportsAMMV2.setScoreForGame(
				ticketGame1.gameId,
				ticketGame1.playerPropsId,
				ticketGame1.playerId,
				98,
				100
			);

			// exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);

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

		it('Should be positive round - ticket in the next round', async () => {
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
			const quote = await sportsAMMV2.tradeQuote(tradeDataNextRound, BUY_IN_AMOUNT);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataNextRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// difference between payout and buy-in (amount taken from default LP)
			// buy-in without fees: 9.8
			// payout: 20
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				ethers.formatEther(quote.payout) - ethers.formatEther(quote.buyInAmountAfterFees);

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
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
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
			expect(currentRoundAllocation).to.equal(ethers.parseEther('1010.2'));

			expect(currentRound).to.equal(3);

			// try exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);

			// resolve ticket game as loss for the user
			const ticketGame1 = tradeDataNextRound[0];
			await sportsAMMV2.setScoreForGame(
				ticketGame1.gameId,
				ticketGame1.playerPropsId,
				ticketGame1.playerId,
				98,
				100
			);

			// exercise ticket on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);

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
			const roundProfitWithoutSafeBox = roundProfit * (1 - safeBoxImpact);
			const calculatedPnl =
				1 + roundProfitWithoutSafeBox / ethers.formatEther(currentRoundAllocation);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

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

		// TODO - not finished
		it('Should be positive round - ticket in cross rounds', async () => {
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
			const quote = await sportsAMMV2.tradeQuote(tradeDataCrossRounds, BUY_IN_AMOUNT);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCrossRounds,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// difference between payout and buy-in (amount taken from default LP)
			// buy-in without fees: 9.8
			// payout: 40
			// diff taken from LP: 30.2
			const diffPayoutBuyIn =
				ethers.formatEther(quote.payout) - ethers.formatEther(quote.buyInAmountAfterFees);

			let currentRoundPoolBalanceAfterTrade = await collateral.balanceOf(currentRoundPoolAddress);
			let defaultLpBalanceAfterTrade = await collateral.balanceOf(defaultLpAddress);

			const diffDefaultLpBalance =
				ethers.formatEther(defaultLpBalanceBeforeTrade) -
				ethers.formatEther(defaultLpBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(currentRoundPoolBalanceBeforeTrade);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffDefaultLpBalance.toFixed(4));

			// check default round data
			const defaultRound = 1;
			let defaultRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(defaultRound))
			);
			let defaultRoundAddress = await sportsAMMV2LiquidityPool.roundPools(defaultRound);
			expect(defaultRoundAllocation.toFixed(4)).to.equal(diffDefaultLpBalance.toFixed(4));
			expect(defaultRoundAddress).to.equal(defaultLpAddress);

			// get active Ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
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

			// resolve ticket game as loss for the user
			const ticketGame1 = tradeDataCrossRounds[0];
			await sportsAMMV2.setScoreForGame(
				ticketGame1.gameId,
				ticketGame1.playerPropsId,
				ticketGame1.playerId,
				98,
				100
			);
			const ticketGame2 = tradeDataCrossRounds[1];
			await sportsAMMV2.setScoreForGame(
				ticketGame2.gameId,
				ticketGame2.playerPropsId,
				ticketGame2.playerId,
				98,
				100
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

			// const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			// // check safe box profit on positive round
			// const safeBoxBalanceAfterClose = await collateral.balanceOf(safeBox);
			// const diffSafeBoxBalance =
			// 	ethers.formatEther(safeBoxBalanceAfterClose) -
			// 	ethers.formatEther(safeBoxBalanceBeforeClose);

			// const roundProfit =
			// 	ethers.formatEther(currentRoundPoolBalanceAfterExercise) -
			// 	ethers.formatEther(currentRoundAllocation);
			// const safeBoxImpact = ethers.formatEther(await sportsAMMV2LiquidityPool.safeBoxImpact());

			// expect(diffSafeBoxBalance).to.greaterThan(0);
			// expect(diffSafeBoxBalance.toFixed(4)).to.equal((roundProfit * safeBoxImpact).toFixed(4));

			// // check PnL
			// const currentRoundPnl = Number(
			// 	ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			// );
			// const currentRoundCumulativePnl = Number(
			// 	ethers.formatEther(await sportsAMMV2LiquidityPool.cumulativeProfitAndLoss(currentRound))
			// );
			// const roundProfitWithoutSafeBox = roundProfit * (1 - safeBoxImpact);
			// const calculatedPnl =
			// 	1 + roundProfitWithoutSafeBox / ethers.formatEther(currentRoundAllocation);

			// expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			// expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// // check default LP balance
			// const calculatedDefaultLpProfit = diffDefaultLpBalance * (currentRoundPnl - 1);
			// let defaultLpBalanceAfterWithdrawal = await collateral.balanceOf(defaultLpAddress);
			// let defaultLpProfit =
			// 	ethers.formatEther(defaultLpBalanceAfterWithdrawal) -
			// 	ethers.formatEther(defaultLpBalanceBeforeTrade);
			// expect(defaultLpProfit.toFixed(8)).to.equal(calculatedDefaultLpProfit.toFixed(8));

			// // check next round data
			// nextRound = await sportsAMMV2LiquidityPool.round();
			// expect(nextRound).to.equal(4);
			// nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			// const nextRoundPoolBalance = Number(
			// 	ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))
			// );
			// nextRoundAllocation = Number(
			// 	ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound))
			// );
			// const caclucaltedNextRoundAllocation =
			// 	Number(ethers.formatEther(currentRoundAllocation)) +
			// 	roundProfitWithoutSafeBox -
			// 	diffDefaultLpBalance * currentRoundPnl;

			// expect(nextRoundPoolBalance.toFixed(8)).to.equal(caclucaltedNextRoundAllocation.toFixed(8));
			// expect(nextRoundAllocation.toFixed(8)).to.equal(caclucaltedNextRoundAllocation.toFixed(8));
		});
	});
});
