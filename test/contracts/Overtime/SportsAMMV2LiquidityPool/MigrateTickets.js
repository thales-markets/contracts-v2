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
const { setDefaultAutoSelectFamily } = require('net');

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
		tradeDataCrossRounds,
		collateralAmount;

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
		collateralAmount = ethers.parseEther('1000000000000000000000000');
		await collateral.setDefaultAmount(collateralAmount);
		await collateral.mintForUser(firstLiquidityProvider);
		await collateral
			.connect(firstLiquidityProvider)
			.approve(sportsAMMV2LiquidityPool, collateralAmount);
	});

	describe('Trades', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			await sportsAMMV2LiquidityPool.setMaxAllowedDeposit(collateralAmount);
		});

		it('Should migrate a ticket to next round', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let quote;
			for (let i = 0; i < 10; i++) {
				quote = await sportsAMMV2.tradeQuote(
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
			}

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			await sportsAMMV2LiquidityPool.migrateTicketToAnotherRound(ticketAddress, 0, 0);

			const numOfTicketsAfterMigration =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfterMigration)).to.equal(Number(numOfTickets) - 1);

			const ticketRoundAfterMigration =
				await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
			expect(Number(ticketRoundAfterMigration)).to.equal(Number(currentRound) + 1);
		});

		it('Should migrate a batch of tickets to next round', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let quote;
			for (let i = 0; i < 10; i++) {
				quote = await sportsAMMV2.tradeQuote(
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
			}

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddresses = Array.from(activeTickets.slice(0, 10));
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddresses[0]);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			await sportsAMMV2LiquidityPool.migrateBatchOfTicketsToAnotherRound(ticketAddresses, 0, []);

			const numOfTicketsAfterMigration =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfterMigration)).to.equal(
				Number(numOfTickets) - ticketAddresses.length
			);

			const ticketRoundAfterMigration = await sportsAMMV2LiquidityPool.getTicketRound(
				ticketAddresses[0]
			);
			expect(Number(ticketRoundAfterMigration)).to.equal(Number(currentRound) + 1);
			for (const ticketAddress of ticketAddresses) {
				const ticketRoundAfterMigration =
					await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
				expect(Number(ticketRoundAfterMigration)).to.equal(Number(currentRound) + 1);
			}
		});
		it('Should migrate a batch of tickets to future round (round 10)', async () => {
			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(collateralAmount);
			await sportsAMMV2LiquidityPool.start();
			let quote;
			for (let i = 0; i < 10; i++) {
				quote = await sportsAMMV2.tradeQuote(
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
			}

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddresses = Array.from(activeTickets.slice(0, 10));
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddresses[0]);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			await sportsAMMV2LiquidityPool.migrateBatchOfTicketsToAnotherRound(ticketAddresses, 10, []);

			const numOfTicketsAfterMigration =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfterMigration)).to.equal(
				Number(numOfTickets) - ticketAddresses.length
			);

			const ticketRoundAfterMigration = await sportsAMMV2LiquidityPool.getTicketRound(
				ticketAddresses[0]
			);
			expect(Number(ticketRoundAfterMigration)).to.equal(10);
			for (const ticketAddress of ticketAddresses) {
				const ticketRoundAfterMigration =
					await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
				expect(Number(ticketRoundAfterMigration)).to.equal(10);
			}
		});

		it('Should migrate a batch of tickets to future round (round 10) and exercise current round', async () => {
			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(collateralAmount);
			await sportsAMMV2LiquidityPool.start();
			let quote;
			for (let i = 0; i < 12; i++) {
				quote = await sportsAMMV2.tradeQuote(
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
			}

			// try exercise on LP
			expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddresses = Array.from(activeTickets.slice(0, 10));
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddresses[0]);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			const ticketIndexes = [];
			const maxTicketIndex = 20;
			for (let i = 0; i < ticketAddresses.length; i++) {
				const ticketIndex = await sportsAMMV2LiquidityPool.getTicketIndexInTicketRound(
					ticketAddresses[i],
					currentRound,
					0,
					10
				);
				if (ticketIndex == maxTicketIndex) {
					ticketIndex = 0;
				}
				ticketIndexes.push(ticketIndex);
			}
			await sportsAMMV2LiquidityPool.migrateBatchOfTicketsToAnotherRound(
				ticketAddresses,
				10,
				ticketIndexes
			);

			const numOfTicketsAfterMigration =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfterMigration)).to.equal(
				Number(numOfTickets) - ticketAddresses.length
			);

			const ticketRoundAfterMigration = await sportsAMMV2LiquidityPool.getTicketRound(
				ticketAddresses[0]
			);
			expect(Number(ticketRoundAfterMigration)).to.equal(10);
			for (const ticketAddress of ticketAddresses) {
				const ticketRoundAfterMigration =
					await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
				expect(Number(ticketRoundAfterMigration)).to.equal(10);
			}
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

		it('Should migrate a batch of tickets to future round (round 10) and exercise current round', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(collateralAmount);
			await sportsAMMV2LiquidityPool.start();
			let quote;
			const actualNumOfTickets = 5;
			const totalNumOfDummyTickets = 10;
			// const remainingTickets = totalNumOfDummyTickets - actualNumOfTickets;
			// const batchSize = 500;
			// for (let i = 0; i < remainingTickets; i += batchSize) {
			//     const ticketsToAdd = Math.min(batchSize, remainingTickets - i);
			//     await sportsAMMV2LiquidityPool.addTicketsToRound(ticketsToAdd);
			// }

			for (let i = 0; i < totalNumOfDummyTickets; i++) {
				quote = await sportsAMMV2.tradeQuote(
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
			}

			// try exercise on LP
			// expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(false);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, actualNumOfTickets);
			const ticketAddresses = Array.from(activeTickets);
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddresses[0]);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			// For each ticket, find its index in the round
			for (let i = 0; i < ticketAddresses.length; i++) {
				// Use the getTicketIndexInTicketRound helper to find the index
				const ticketIndex = await sportsAMMV2LiquidityPool.getTicketIndexInTicketRound(
					ticketAddresses[i],
					currentRound,
					0,
					totalNumOfDummyTickets
				);
				if (ticketIndex == totalNumOfDummyTickets) {
					ticketIndex = 0;
				}
				await sportsAMMV2LiquidityPool.migrateTicketToAnotherRound(
					ticketAddresses[i],
					actualNumOfTickets,
					ticketIndex
				);
			}

			const numOfTicketsAfterMigration =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfterMigration)).to.equal(
				Number(numOfTickets) - ticketAddresses.length
			);

			const ticketRoundAfterMigration = await sportsAMMV2LiquidityPool.getTicketRound(
				ticketAddresses[0]
			);
			expect(Number(ticketRoundAfterMigration)).to.equal(actualNumOfTickets);
			for (const ticketAddress of ticketAddresses) {
				const ticketRoundAfterMigration =
					await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
				expect(Number(ticketRoundAfterMigration)).to.equal(actualNumOfTickets);
			}
			const ticketMarket1 = tradeDataTenMarketsCurrentRound[9];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			// await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
		});
	});
});
