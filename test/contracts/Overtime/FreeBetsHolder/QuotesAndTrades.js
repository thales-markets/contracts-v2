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
		sportsAMMV2ResultManager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			freeBetsHolder,
			collateralAddress,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			liveTradingProcessor,
			sportsAMMV2ResultManager,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade with free bet', () => {
		it('Should fail with unsupported collateral', async () => {
			await freeBetsHolder.addSupportedCollateral(collateralAddress, false);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			expect(
				freeBetsHolder
					.connect(firstTrader)
					.trade(
						tradeDataCurrentRound,
						BUY_IN_AMOUNT,
						quote.payout,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						collateralAddress
					)
			).to.be.revertedWith('Unsupported collateral');
		});

		it('Should pass', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
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
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress
				);
		});

		it('Should pass live', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);

			const firstTraderBalance = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalance).to.equal(ethers.parseEther('10'));

			await freeBetsHolder
				.connect(firstTrader)
				.tradeLive(
					tradeDataCurrentRound[0].gameId,
					tradeDataCurrentRound[0].sportId,
					tradeDataCurrentRound[0].typeId,
					tradeDataCurrentRound[0].position,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralAddress
				);

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.payout);
		});

		it('Should claim winnings', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
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
					quote.payout,
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

			const activeTickets = await sportsAMMV2Data.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);

			const firstTraderBalanceAfterClaim = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfterClaim).to.equal(ethers.parseEther('10'));
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
				ZERO_ADDRESS
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
					quote.payout,
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
		});
	});
});
