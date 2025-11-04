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
const { ethers } = require('hardhat');

describe('SportsAMMV2LiquidityPool Trades', function () {
	// Give this whole suite more time on CI
	this.timeout(120000);

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
		collateralAmount,
		secondAccount,
		thirdAccount,
		owner;

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
		({ firstLiquidityProvider, firstTrader, secondAccount, thirdAccount, owner } =
			await loadFixture(deployAccountsFixture));

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
			for (let i = 0; i < 5; i++) {
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
			for (let i = 0; i < 5; i++) {
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
			const ticketAddresses = Array.from(activeTickets);
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
			for (let i = 0; i < 5; i++) {
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
			const ticketAddresses = Array.from(activeTickets.slice(0, 5));
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
			for (let i = 0; i < 7; i++) {
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
			const ticketAddresses = Array.from(activeTickets.slice(0, 5));
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddresses[0]);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			const ticketIndexes = [];
			const maxTicketIndex = 7;
			for (let i = 0; i < ticketAddresses.length; i++) {
				const tupleIndexAndFound = await sportsAMMV2LiquidityPool.getTicketIndexInTicketRound(
					ticketAddresses[i],
					currentRound,
					0,
					maxTicketIndex
				);
				if (tupleIndexAndFound[0] == maxTicketIndex) {
					tupleIndexAndFound[0] = 0;
				}
				ticketIndexes.push(tupleIndexAndFound[0]);
			}

			const ticketIndexAndFound = await sportsAMMV2LiquidityPool.getTicketIndexInTicketRound(
				ZERO_ADDRESS,
				currentRound,
				0,
				maxTicketIndex
			);
			expect(Number(ticketIndexAndFound[0])).to.equal(maxTicketIndex);

			// 👇 need to await this revert assertion
			await expect(
				sportsAMMV2LiquidityPool.migrateBatchOfTicketsToAnotherRound(
					ticketAddresses,
					10,
					ticketIndexes
				)
			).to.be.revertedWith('TicketIndexMustBeGreaterThan0');

			await sportsAMMV2LiquidityPool.migrateBatchOfTicketsToAnotherRound(
				ticketAddresses.slice(1, 5),
				10,
				ticketIndexes.slice(1, 5)
			);

			const tupleIndexAndFound2 = await sportsAMMV2LiquidityPool.getTicketIndexInTicketRound(
				ZERO_ADDRESS,
				currentRound,
				0,
				1
			);
			expect(Number(tupleIndexAndFound2[0])).to.equal(1);
			const numOfTicketsAfterMigration =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfterMigration)).to.equal(
				Number(numOfTickets) - (ticketAddresses.length - 1)
			);

			const ticketRoundAfterMigration = await sportsAMMV2LiquidityPool.getTicketRound(
				ticketAddresses[1]
			);
			expect(Number(ticketRoundAfterMigration)).to.equal(10);
			for (const ticketAddress of ticketAddresses.slice(1, 5)) {
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

		it('Should migrate a batch of tickets individually to future round (round 10) and exercise current round', async function () {
			// extra safety timeout for this heavier test
			this.timeout(120000);

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(collateralAmount);
			await sportsAMMV2LiquidityPool.start();
			let quote;
			const actualNumOfTickets = 5;
			const totalNumOfDummyTickets = 10;

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

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, actualNumOfTickets);
			const ticketAddresses = Array.from(activeTickets);
			const currentRound = await sportsAMMV2LiquidityPool.round();
			const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(ticketAddresses[0]);
			expect(Number(ticketRound)).to.equal(Number(currentRound));
			const numOfTickets =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			// For each ticket, find its index in the round
			for (let i = 0; i < ticketAddresses.length; i++) {
				const tupleIndexAndFound = await sportsAMMV2LiquidityPool.getTicketIndexInTicketRound(
					ticketAddresses[i],
					currentRound,
					0,
					totalNumOfDummyTickets
				);
				let ticketIndex = tupleIndexAndFound[0];
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

			// Optionally exercise, commented out originally
			// expect(await sportsAMMV2LiquidityPool.hasTicketsReadyToBeExercised()).to.equal(true);
			// await sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10);
		});

		it('Should allow whitelisted address to migrate tickets and reject non-whitelisted address', async () => {
			const initialDeposit = ethers.parseEther('1000');

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let quote;
			for (let i = 0; i < 3; i++) {
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

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];
			const currentRound = await sportsAMMV2LiquidityPool.round();

			await expect(
				sportsAMMV2LiquidityPool
					.connect(secondAccount)
					.migrateTicketToAnotherRound(ticketAddress, 0, 0)
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2Manager.setWhitelistedAddresses(
				[secondAccount.address],
				2, // ISportsAMMV2Manager.Role.MARKET_RESOLVING
				true
			);

			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount.address, 2)).to.equal(
				true
			);

			//  Whitelisted address should be able to migrate ticket
			const numOfTicketsBefore =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			await sportsAMMV2LiquidityPool
				.connect(secondAccount)
				.migrateTicketToAnotherRound(ticketAddress, 0, 0);

			const numOfTicketsAfter =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfter)).to.equal(Number(numOfTicketsBefore) - 1);

			// Verify ticket was migrated to next round
			const ticketRoundAfterMigration =
				await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
			expect(Number(ticketRoundAfterMigration)).to.equal(Number(currentRound) + 1);

			// Owner should always be able to migrate tickets (test with another ticket)
			const secondTicketAddress = activeTickets[1];

			// Owner should be able to migrate without explicit whitelisting
			await sportsAMMV2LiquidityPool
				.connect(owner)
				.migrateTicketToAnotherRound(secondTicketAddress, 0, 0);

			// Test 5: Remove whitelist and verify access is revoked
			await sportsAMMV2Manager.setWhitelistedAddresses(
				[secondAccount.address],
				2, // ISportsAMMV2Manager.Role.MARKET_RESOLVING
				false
			);

			// Verify the address is no longer whitelisted
			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount.address, 2)).to.equal(
				false
			);

			// Should be rejected again
			const thirdTicketAddress = activeTickets[2];
			await expect(
				sportsAMMV2LiquidityPool
					.connect(secondAccount)
					.migrateTicketToAnotherRound(thirdTicketAddress, 0, 0)
			).to.be.revertedWith('Invalid sender');
		});

		it('Should allow whitelisted address to migrate batch of tickets and reject non-whitelisted address', async () => {
			const initialDeposit = ethers.parseEther('1000');

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(initialDeposit);
			await sportsAMMV2LiquidityPool.start();

			let quote;
			for (let i = 0; i < 5; i++) {
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

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddresses = Array.from(activeTickets.slice(0, 3));
			const currentRound = await sportsAMMV2LiquidityPool.round();

			// Non-whitelisted address should be rejected for batch migration
			await expect(
				sportsAMMV2LiquidityPool
					.connect(thirdAccount)
					.migrateBatchOfTicketsToAnotherRound(ticketAddresses, 0, [])
			).to.be.revertedWith('Invalid sender');

			// Whitelist thirdAccount with MARKET_RESOLVING role (role = 2)
			await sportsAMMV2Manager.setWhitelistedAddresses(
				[thirdAccount.address],
				2, // ISportsAMMV2Manager.Role.MARKET_RESOLVING
				true
			);

			// Whitelisted address should be able to migrate batch of tickets
			const numOfTicketsBefore =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);

			await sportsAMMV2LiquidityPool
				.connect(thirdAccount)
				.migrateBatchOfTicketsToAnotherRound(ticketAddresses, 0, []);

			const numOfTicketsAfter =
				await sportsAMMV2LiquidityPool.getNumberOfTradingTicketsPerRound(currentRound);
			expect(Number(numOfTicketsAfter)).to.equal(
				Number(numOfTicketsBefore) - ticketAddresses.length
			);

			// Verify all tickets were migrated to next round
			for (const ticketAddress of ticketAddresses) {
				const ticketRoundAfterMigration =
					await sportsAMMV2LiquidityPool.getTicketRound(ticketAddress);
				expect(Number(ticketRoundAfterMigration)).to.equal(Number(currentRound) + 1);
			}
		});
	});
});
