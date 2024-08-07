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

describe('StakingThalesBettingProxy', () => {
	let sportsAMMV2,
		sportsAMMV2Data,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2THALESLiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		stakingThalesBettingProxy,
		collateralTHALESAddress,
		sportsAMMV2RiskManager,
		mockChainlinkOracle,
		liveTradingProcessor,
		sportsAMMV2ResultManager,
		stakingThales;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2THALESLiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			stakingThalesBettingProxy,
			collateralTHALESAddress,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			liveTradingProcessor,
			sportsAMMV2ResultManager,
			stakingThales,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await sportsAMMV2THALESLiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2THALESLiquidityPool.start();
	});

	describe('Trade with staked tokens', () => {
		it('Should fail with insufficient staked amount', async () => {
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('5')); // Stake less than required

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			console.log(tradeDataCurrentRound);
			console.log(BUY_IN_AMOUNT);
			console.log(quote);
			expect(Number(quote.payout.toString() / 1e18).toFixed(5)).to.equal(
				Number(Number(BUY_IN_AMOUNT.toString()) / Number(quote.totalQuote.toString())).toFixed(5)
			);

			await expect(
				stakingThalesBettingProxy
					.connect(firstTrader)
					.trade(
						tradeDataCurrentRound,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						collateralTHALESAddress
					)
			).to.be.revertedWith('Insufficient staked balance');
		});

		it('Should pass', async () => {
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			expect(Number(quote.payout.toString() / 1e18).toFixed(5)).to.equal(
				Number(Number(BUY_IN_AMOUNT.toString()) / Number(quote.totalQuote.toString())).toFixed(5)
			);

			await stakingThalesBettingProxy
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					collateralTHALESAddress
				);

			const activeTickets = await stakingThalesBettingProxy.getActiveTicketsPerUser(
				0,
				1,
				firstTrader
			);
			expect(activeTickets.length).to.equal(1);
		});

		it('Should pass live', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			await stakingThalesBettingProxy.connect(firstTrader).tradeLive({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: collateralTHALESAddress,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);
		});

		it('Should claim winnings', async () => {
			console.log('TRADE DATA CURRENT ROUND: ', tradeDataCurrentRound);
			console.log('\n\n ________________________________________');

			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked
			const stakingBalanceInit = await stakingThales.stakedBalanceOf(firstTrader);
			console.log('at start: ', stakingBalanceInit.toString());

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			await stakingThalesBettingProxy
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					collateralTHALESAddress
				);

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataCurrentRound[0].gameId],
				[tradeDataCurrentRound[0].typeId],
				[tradeDataCurrentRound[0].playerId],
				[[0]]
			);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];
			const ticketsDataBeforeExercise = await sportsAMMV2Data.getTicketsData([ticketAddress]);
			console.log('firstTrader: ', firstTrader.address);
			console.log('\n TICKETS DATA before exercise: ');
			console.log('ticketOwner: ', ticketsDataBeforeExercise[0][0]);
			console.log('isUserTheWinner: ', ticketsDataBeforeExercise[0][15]);
			console.log('isExercisable: ', ticketsDataBeforeExercise[0][16]);
			console.log('resolved: ', ticketsDataBeforeExercise[0][11]);
			const stakingBalanceBefore = await stakingThales.stakedBalanceOf(firstTrader.address);
			console.log('before: ', stakingBalanceBefore.toString());
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const ticketsData = await sportsAMMV2Data.getTicketsData([ticketAddress]);
			console.log('\n TICKETS DATA after exercise: ');
			console.log('ticketOwner: ', ticketsData[0][0]);
			console.log('isUserTheWinner: ', ticketsData[0][15]);
			console.log('isExercisable: ', ticketsData[0][16]);
			console.log('resolved: ', ticketsData[0][11]);
			console.log('\n TICKETS DATA======================== ');

			const firstTraderStakedBalance = await stakingThales.stakedBalanceOf(firstTrader.address);
			console.log('after: ', firstTraderStakedBalance.toString());
			expect(firstTraderStakedBalance).to.be.above(stakingBalanceBefore); // Ensure it increased after winning
		});

		// it('User tickets history getters', async () => {
		//     await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked

		//     const quote = await sportsAMMV2.tradeQuote(
		//         tradeDataCurrentRound,
		//         BUY_IN_AMOUNT,
		//         ZERO_ADDRESS,
		//         false
		//     );

		//     await stakingThalesBettingProxy
		//         .connect(firstTrader)
		//         .trade(
		//             tradeDataCurrentRound,
		//             BUY_IN_AMOUNT,
		//             quote.totalQuote,
		//             ADDITIONAL_SLIPPAGE,
		//             ZERO_ADDRESS
		//         );

		//     let numActive = await stakingThalesBettingProxy.numOfActiveTicketsPerUser(firstTrader);
		//     expect(numActive).to.equal(1);

		//     await stakingThalesBettingProxy.getActiveTicketsPerUser(0, 1, firstTrader);

		//     let numResolved = await stakingThalesBettingProxy.numOfResolvedTicketsPerUser(firstTrader);
		//     expect(numResolved).to.equal(0);

		//     await stakingThalesBettingProxy.getResolvedTicketsPerUser(0, 1, firstTrader);

		//     const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		//     const ticketAddress = activeTickets[0];

		//     const [, activeStakedTokensData] = await sportsAMMV2Data.getActiveTicketsDataPerUser(
		//         firstTrader,
		//         0,
		//         100
		//     );
		//     expect(activeStakedTokensData.length).to.be.equal(1);
		//     expect(activeStakedTokensData[0].id).to.be.equal(ticketAddress);

		//     const [, resolvedStakedTokens] = await sportsAMMV2Data.getResolvedTicketsDataPerUser(
		//         firstTrader,
		//         0,
		//         100
		//     );
		//     expect(resolvedStakedTokens.length).to.be.equal(0);
		// });
	});
});
