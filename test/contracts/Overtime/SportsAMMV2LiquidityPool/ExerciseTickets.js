const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');
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
		collateral,
		safeBox,
		firstLiquidityProvider,
		firstTrader,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataTenMarketsCurrentRound,
		tradeDataTenMarketsCurrentRoundFirst,
		tradeDataTenMarketsCurrentRoundSecond,
		tradeDataTenMarketsCurrentRoundThird,
		tradeDataTenMarketsCurrentRoundFourth,
		tradeDataTenMarketsCurrentRoundFifth,
		tradeDataTenMarketsCurrentRoundSixth,
		tradeDataTenMarketsCurrentRoundSeventh,
		tradeDataTenMarketsCurrentRoundEighth,
		tradeDataTenMarketsCurrentRoundNineth,
		tradeDataTenMarketsCurrentRoundTenth,
		tradeDataCrossRounds;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
			collateral,
			safeBox,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRoundFirst,
			tradeDataTenMarketsCurrentRoundSecond,
			tradeDataTenMarketsCurrentRoundThird,
			tradeDataTenMarketsCurrentRoundFourth,
			tradeDataTenMarketsCurrentRoundFifth,
			tradeDataTenMarketsCurrentRoundSixth,
			tradeDataTenMarketsCurrentRoundSeventh,
			tradeDataTenMarketsCurrentRoundEighth,
			tradeDataTenMarketsCurrentRoundNineth,
			tradeDataTenMarketsCurrentRoundTenth,
			tradeDataTenMarketsCurrentRound,
			tradeDataNextRound,
			tradeDataCrossRounds,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

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

	describe('Trades', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
		});

		it('Should be ticket in the next round (positive round)', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let quote = await sportsAMMV2.tradeQuote(
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

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundFirst,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundFirst,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundFirst,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundFirst,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundSecond,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundSecond,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundThird,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundThird,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundFourth,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundFourth,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundFifth,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundFifth,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundSixth,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundSixth,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundSeventh,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundSeventh,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundEighth,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundEighth,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundNineth,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundNineth,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRoundTenth,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRoundTenth,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);

			const ticketMarket1 = tradeDataTenMarketsCurrentRound[9];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
		});
	});
});
