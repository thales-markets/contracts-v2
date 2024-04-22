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
	ETH_BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	DEFAULT_AMOUNT,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
} = require('../../../constants/overtime');

const { SPORTS_AMM_SIX_DEC_INITAL_PARAMS } = require('../../../constants/overtimeContractParams');

describe('SportsAMMV2LiquidityPool Six decimal - Trades', () => {
	let sportsAMMV2,
		sportsAMMV2ResultManager,
		sportsAMMV2RiskManager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolSixDecimals,
		defaultLiquidityProviderSixDecimals,
		sportsAMMV2LiquidityPoolSixDecimals2,
		defaultLiquidityProviderSixDecimals2,
		sportsAMMV2LiquidityPoolETH,
		defaultLiquidityProviderETH,
		weth,
		collateral,
		collateral18,
		collateralSixDecimals,
		collateralSixDecimals2,
		multiCollateral,
		positionalManager,
		stakingThales,
		safeBox,
		priceFeed,
		firstLiquidityProvider,
		firstTrader,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2ResultManager,
			sportsAMMV2RiskManager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2LiquidityPoolSixDecimals,
			defaultLiquidityProviderSixDecimals,
			sportsAMMV2LiquidityPoolSixDecimals2,
			defaultLiquidityProviderSixDecimals2,
			sportsAMMV2LiquidityPoolETH,
			defaultLiquidityProviderETH,
			weth,
			collateral,
			collateral18,
			collateralSixDecimals,
			collateralSixDecimals2,
			multiCollateral,
			positionalManager,
			stakingThales,
			priceFeed,
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

	describe('Six decimal basic checks', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('Multicollateral buy', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			let multiCollateralMinimumReceived = await multiCollateral.getMinimumReceived(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT_SIX_DECIMALS
			);

			let multiCollateralMinimumNeeded = await multiCollateral.getMinimumNeeded(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT
			);
			expect(multiCollateralMinimumReceived).to.equal(BUY_IN_AMOUNT);
			expect(multiCollateralMinimumNeeded).to.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
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
				Number(ethers.formatEther(quote.buyInAmountInDefaultCollateral));

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

		it('Using six decimal as a default collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				ZERO_ADDRESS
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('Pool is six decimal and default collateral 18 decimal', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
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
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});
	});
	describe('Six decimal default collateral', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('6 decimal - default collateral, 18 decimal - LP collateral, 18 decimal - staking collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool18WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateral.target,
				sportsAMMV2LiquidityPool.target
			);
			const initialDeposit18 = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPool18WithFirstLiquidityProvider.deposit(initialDeposit18);
			await sportsAMMV2LiquidityPool.start();

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit18.toString());
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, collateral);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateral,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
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

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPool.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPool.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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

		it('6 decimal - default collateral, 18 decimal - LP collateral, 6 decimal - staking collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool18WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateral.target,
				sportsAMMV2LiquidityPool.target
			);
			const initialDeposit18 = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPool18WithFirstLiquidityProvider.deposit(initialDeposit18);
			await sportsAMMV2LiquidityPool.start();

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit18.toString());
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, collateral);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateral,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
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

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPool.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPool.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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

		it('6 decimal - default collateral, 6 decimal - LP collateral, 18 decimal - staking collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool2WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals2.connect(firstLiquidityProvider);

			const initialDeposit = 1000 * 1e6;
			await collateralSixDecimals2
				.connect(firstLiquidityProvider)
				.approve(sportsAMMV2LiquidityPoolSixDecimals2, initialDeposit);

			expect(await sportsAMMV2LiquidityPoolSixDecimals2.collateral()).to.be.equal(
				collateralSixDecimals2.target
			);

			await sportsAMMV2LiquidityPoolSixDecimals2
				.connect(firstLiquidityProvider)
				.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals2.start();

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			await sportsAMMV2.setAddresses(
				collateralSixDecimals2.target,
				await sportsAMMV2.riskManager()
			);
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals2.target,
				sportsAMMV2LiquidityPoolSixDecimals2.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());

			let currentRound2 = Number(await sportsAMMV2LiquidityPoolSixDecimals2.round());
			let currentRoundPool2Address =
				await sportsAMMV2LiquidityPoolSixDecimals2.roundPools(currentRound2);
			let currentRoundPoolBalanceBeforeTrade2 =
				await collateralSixDecimals2.balanceOf(currentRoundPool2Address);

			expect(currentRoundPoolBalanceBeforeTrade2.toString()).to.equal(initialDeposit.toString());

			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('6 decimal - default collateral, 6 decimal - LP collateral, 6 decimal - staking collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool2WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals2.connect(firstLiquidityProvider);

			const initialDeposit = 1000 * 1e6;
			await collateralSixDecimals2
				.connect(firstLiquidityProvider)
				.approve(sportsAMMV2LiquidityPoolSixDecimals2, initialDeposit);

			expect(await sportsAMMV2LiquidityPoolSixDecimals2.collateral()).to.be.equal(
				collateralSixDecimals2.target
			);

			await sportsAMMV2LiquidityPoolSixDecimals2
				.connect(firstLiquidityProvider)
				.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals2.start();

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			await sportsAMMV2.setAddresses(
				collateralSixDecimals2.target,
				await sportsAMMV2.riskManager()
			);
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals2.target,
				sportsAMMV2LiquidityPoolSixDecimals2.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());

			let currentRound2 = Number(await sportsAMMV2LiquidityPoolSixDecimals2.round());
			let currentRoundPool2Address =
				await sportsAMMV2LiquidityPoolSixDecimals2.roundPools(currentRound2);
			let currentRoundPoolBalanceBeforeTrade2 =
				await collateralSixDecimals2.balanceOf(currentRoundPool2Address);

			expect(currentRoundPoolBalanceBeforeTrade2.toString()).to.equal(initialDeposit.toString());

			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});
	});
	describe('18 decimal default collateral', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('18 decimal - default collateral, 6 decimal - LP collateral, 6 decimal - staking collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);

			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('18 decimal - default collateral, 6 decimal - LP collateral, 18 decimal - staking collateral', async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);

			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('18 decimal - default collateral, 18 decimal - LP collateral, 18 decimal - staking collateral', async () => {
			const initialDeposit = ethers.parseEther('1');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolETH.connect(firstLiquidityProvider).deposit(initialDeposit);

			await sportsAMMV2LiquidityPoolETH.start();

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);
			collateral = weth;
			let currentRound = Number(await sportsAMMV2LiquidityPoolETH.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPoolETH.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// const eth_price = await priceFeed.rateForCurrency(ethers.encodeBytes32String('ETH'));
			// const buyInAmountTransformed =
			// 	(parseInt(ETH_BUY_IN_AMOUNT.toString()) * parseInt(eth_price.toString())) / 1e18;

			// // create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				ETH_BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					ETH_BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					weth,
					true,
					{ value: ETH_BUY_IN_AMOUNT }
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(BUY_IN_AMOUNT).to.be.lessThanOrEqual(volumeFirstTrader);

			// // difference between payout and buy-in (amount taken from LP)
			// // buy-in without fees: 9.8
			// // payout: 20
			// // diff taken from LP: 10.8
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(ETH_BUY_IN_AMOUNT));

			let currentRoundPoolBalanceAfterTrade = await collateral.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);
			expect(currentRoundPoolBalanceAfterTrade).to.equal(ethers.parseEther('0.997085714285714242'));
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// // get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// // check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolETH.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolETH.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolETH.tradingTicketsPerRound(currentRound, 0)).to.equal(
				ticketAddress
			);
			expect(
				await sportsAMMV2LiquidityPoolETH.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolETH.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolETH.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolETH.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolETH.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolETH.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPoolETH.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolETH.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolETH.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime = await sportsAMMV2LiquidityPoolETH.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolETH.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolETH.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolETH.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolETH.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolETH.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolETH.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolETH.closeRound();

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
				ethers.formatEther(await sportsAMMV2LiquidityPoolETH.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolETH.cumulativeProfitAndLoss(currentRound))
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolETH.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolETH.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolETH.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});
		it('18 decimal - default collateral, 18 decimal - LP collateral, 6 decimal - staking collateral', async () => {
			const initialDeposit = ethers.parseEther('1');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolETH.connect(firstLiquidityProvider).deposit(initialDeposit);

			await sportsAMMV2LiquidityPoolETH.start();

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);
			collateral = weth;
			let currentRound = Number(await sportsAMMV2LiquidityPoolETH.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPoolETH.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);

			// // create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				ETH_BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					ETH_BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					weth,
					true,
					{ value: ETH_BUY_IN_AMOUNT }
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(BUY_IN_AMOUNT_SIX_DECIMALS).to.be.lessThanOrEqual(volumeFirstTrader);

			// // difference between payout and buy-in (amount taken from LP)
			// // buy-in without fees: 9.8
			// // payout: 20
			// // diff taken from LP: 10.8
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(ETH_BUY_IN_AMOUNT));

			let currentRoundPoolBalanceAfterTrade = await collateral.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);
			expect(currentRoundPoolBalanceAfterTrade).to.equal(ethers.parseEther('0.997085714285714242'));
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// // get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// // check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolETH.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolETH.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolETH.tradingTicketsPerRound(currentRound, 0)).to.equal(
				ticketAddress
			);
			expect(
				await sportsAMMV2LiquidityPoolETH.isTradingTicketInARound(currentRound, ticketAddress)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolETH.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolETH.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolETH.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolETH.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolETH.hasTicketsReadyToBeExercised()).to.equal(false);
			await sportsAMMV2LiquidityPoolETH.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolETH.ticketAlreadyExercisedInRound(currentRound, ticketAddress)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateral.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolETH.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime = await sportsAMMV2LiquidityPoolETH.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateral.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolETH.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolETH.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolETH.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolETH.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolETH.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolETH.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolETH.closeRound();

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
				ethers.formatEther(await sportsAMMV2LiquidityPoolETH.profitAndLossPerRound(currentRound))
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolETH.cumulativeProfitAndLoss(currentRound))
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolETH.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolETH.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolETH.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});
	});
	describe('MultiCollateral buy with different decimals', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('6 decimal - default collateral, 6 decimal - multiCollateral , 6 decimal - staking collateral', async () => {
			await multiCollateral.setSUSD(collateralSixDecimals);
			positionalManager.setTransformingCollateral(true);

			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool2WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals2.connect(firstLiquidityProvider);

			const initialDeposit = 1000 * 1e6;

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());

			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals2
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals2,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('6 decimal - default collateral, 6 decimal - multiCollateral , 18 decimal - staking collateral', async () => {
			positionalManager.setTransformingCollateral(true);
			await multiCollateral.setSUSD(collateralSixDecimals);
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool2WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals2.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());

			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals2
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals2,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('6 decimal - default collateral, 18 decimal - multiCollateral , 6 decimal - staking collateral', async () => {
			positionalManager.setTransformingCollateral(true);
			await multiCollateral.setSUSD(collateralSixDecimals);
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool2WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals2.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());

			let liquidityPoolForCollateral = await sportsAMMV2.liquidityPoolForCollateral(collateral);
			expect(liquidityPoolForCollateral).to.be.equal(sportsAMMV2LiquidityPool.target);

			await sportsAMMV2.setLiquidityPoolForCollateral(collateral, ZERO_ADDRESS);
			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, collateral);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateral,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});
		it('6 decimal - default collateral, 18 decimal - multiCollateral , 18 decimal - staking collateral', async () => {
			positionalManager.setTransformingCollateral(true);
			await multiCollateral.setSUSD(collateralSixDecimals);
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals.connect(firstLiquidityProvider);

			let sportsAMMV2LiquidityPool2WithFirstLiquidityProvider =
				sportsAMMV2LiquidityPoolSixDecimals2.connect(firstLiquidityProvider);

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			await sportsAMMV2.setAddresses(collateralSixDecimals.target, await sportsAMMV2.riskManager());
			await sportsAMMV2.setLiquidityPoolForCollateral(
				collateralSixDecimals.target,
				sportsAMMV2LiquidityPoolSixDecimals.target
			);
			await priceFeed.setDefaultCollateralDecimals(6);

			await sportsAMMV2RiskManager.setTicketParams(
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.minBuyInAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxTicketSize,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedAmount,
				SPORTS_AMM_SIX_DEC_INITAL_PARAMS.maxSupportedOdds
			);

			const initialDeposit = 1000 * 1e6;

			// // deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPoolSixDecimals.start();

			let currentRound = Number(await sportsAMMV2LiquidityPoolSixDecimals.round());
			let currentRoundPoolAddress =
				await sportsAMMV2LiquidityPoolSixDecimals.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade.toString()).to.equal(initialDeposit.toString());
			let liquidityPoolForCollateral = await sportsAMMV2.liquidityPoolForCollateral(collateral);
			expect(liquidityPoolForCollateral).to.be.equal(sportsAMMV2LiquidityPool.target);
			await sportsAMMV2.setLiquidityPoolForCollateral(collateral, ZERO_ADDRESS);

			// create a ticket

			const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, collateral);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateral,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);
			// // difference between payout and buy-in (amount taken from LP)
			// // payout: 20
			// // fees: 0.2
			// // buy-in: 10
			// // diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(BUY_IN_AMOUNT_SIX_DECIMALS));

			let currentRoundPoolBalanceAfterTrade =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);

			const diffCurrentRoundPoolBalance =
				ethers.formatEther(currentRoundPoolBalanceBeforeTrade) -
				ethers.formatEther(currentRoundPoolBalanceAfterTrade);

			expect(currentRoundPoolBalanceAfterTrade).to.equal(989.8 * 1e6);
			expect(diffPayoutBuyIn.toFixed(4)).to.equal(diffCurrentRoundPoolBalance.toFixed(4));

			// get active ticket from Sports AMM
			expect(await sportsAMMV2.numOfActiveTickets()).to.equal(1);
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			// check ticket data on LP
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundPerTicket(ticketAddress)).to.equal(
				currentRound
			);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketRound(ticketAddress)).to.equal(
				currentRound
			);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.tradingTicketsPerRound(currentRound, 0)
			).to.equal(ticketAddress);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.isTradingTicketInARound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(false);
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.getNumberOfTradingTicketsPerRound(currentRound)
			).to.equal(1);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.getTicketPool(ticketAddress)).to.equal(
				currentRoundPoolAddress
			);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// resolve ticket market as winning for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// exercise ticket on LP (hasTicketsReadyToBeExercised should be false since it is winning ticket for the user)
			expect(await sportsAMMV2LiquidityPoolSixDecimals.hasTicketsReadyToBeExercised()).to.equal(
				false
			);
			await sportsAMMV2LiquidityPoolSixDecimals.exerciseTicketsReadyToBeExercised();
			expect(
				await sportsAMMV2LiquidityPoolSixDecimals.ticketAlreadyExercisedInRound(
					currentRound,
					ticketAddress
				)
			).to.equal(true);

			let currentRoundPoolBalanceAfterExercise =
				await collateralSixDecimals.balanceOf(currentRoundPoolAddress);
			expect(currentRoundPoolBalanceAfterExercise).to.equal(currentRoundPoolBalanceAfterTrade);

			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(false);

			// increase time to round close time
			const currentRoundCloseTime =
				await sportsAMMV2LiquidityPoolSixDecimals.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			const safeBoxBalanceBeforeClose = await collateralSixDecimals.balanceOf(safeBox);

			// close round
			expect(await sportsAMMV2LiquidityPoolSixDecimals.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPoolSixDecimals.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPoolSixDecimals.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPoolSixDecimals.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPoolSixDecimals.usersProcessedInRound()).to.equal(1);
			await sportsAMMV2LiquidityPoolSixDecimals.closeRound();

			// check safe box profit on negative round
			const safeBoxBalanceAfterClose = await collateralSixDecimals.balanceOf(safeBox);
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
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.profitAndLossPerRound(currentRound)
				)
			);
			const currentRoundCumulativePnl = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPoolSixDecimals.cumulativeProfitAndLoss(currentRound)
				)
			);
			const calculatedPnl =
				1 + roundProfit / ethers.formatEther(currentRoundPoolBalanceBeforeTrade);

			expect(currentRoundPnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));
			expect(currentRoundCumulativePnl.toFixed(8)).to.equal(calculatedPnl.toFixed(8));

			// check next round data
			const nextRound = await sportsAMMV2LiquidityPoolSixDecimals.round();
			expect(nextRound).to.equal(3);
			const nextRoundPoolAddress = await sportsAMMV2LiquidityPoolSixDecimals.roundPools(nextRound);
			const nextRoundPoolBalance = Number(
				ethers.formatEther(await collateralSixDecimals.balanceOf(nextRoundPoolAddress))
			);
			const nextRoundAllocation = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPoolSixDecimals.allocationPerRound(nextRound))
			);

			expect(nextRoundPoolBalance.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
			expect(nextRoundAllocation.toFixed(4)).to.equal(
				(Number(ethers.formatEther(currentRoundPoolBalanceBeforeTrade)) + roundProfit).toFixed(4)
			);
		});

		it('18 decimal - default collateral, 6 decimal - multicollateral, 6 decimal - staking collateral', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			let multiCollateralMinimumReceived = await multiCollateral.getMinimumReceived(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT_SIX_DECIMALS
			);

			let multiCollateralMinimumNeeded = await multiCollateral.getMinimumNeeded(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT
			);
			expect(multiCollateralMinimumReceived).to.equal(BUY_IN_AMOUNT);
			expect(multiCollateralMinimumNeeded).to.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(quote.buyInAmountInDefaultCollateral));

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

		it('18 decimal - default collateral, 6 decimal - multicollateral, 18 decimal - staking collateral', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			let multiCollateralMinimumReceived = await multiCollateral.getMinimumReceived(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT_SIX_DECIMALS
			);

			let multiCollateralMinimumNeeded = await multiCollateral.getMinimumNeeded(
				collateralSixDecimals.target,
				BUY_IN_AMOUNT
			);
			expect(multiCollateralMinimumReceived).to.equal(BUY_IN_AMOUNT);
			expect(multiCollateralMinimumNeeded).to.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);
			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(quote.buyInAmountInDefaultCollateral));

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

		it('18 decimal - default collateral, 18 decimal - multicollateral, 6 decimal - staking collateral', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			await stakingThales.setFeeToken(collateralSixDecimals);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(6);

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateral18
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateral18,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT_SIX_DECIMALS);
			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(quote.buyInAmountInDefaultCollateral));

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

		it('18 decimal - default collateral, 18 decimal - multicollateral, 18 decimal - staking collateral', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			let currentRound = Number(await sportsAMMV2LiquidityPool.round());
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			let currentRoundPoolBalanceBeforeTrade = await collateral.balanceOf(currentRoundPoolAddress);

			expect(currentRoundPoolBalanceBeforeTrade).to.equal(initialDeposit);
			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateral18
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					collateral18,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);
			// difference between payout and buy-in (amount taken from LP)
			// payout: 20
			// fees: 0.2
			// buy-in: 10
			// diff taken from LP: 10.2
			const diffPayoutBuyIn =
				Number(ethers.formatEther(quote.payout)) +
				Number(ethers.formatEther(quote.fees)) -
				Number(ethers.formatEther(quote.buyInAmountInDefaultCollateral));

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
