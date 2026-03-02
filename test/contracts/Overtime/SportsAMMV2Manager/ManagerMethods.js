const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployTokenFixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	TYPE_ID_TOTAL,
	RESULT_TYPE,
	GAME_ID_1,
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('SportsAMMV2Manager Methods', () => {
	let sportsAMMV2Manager,
		sportsAMMV2,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		collateral,
		collateralSixDecimals,
		owner,
		firstTrader,
		secondAccount,
		firstLiquidityProvider,
		tradeDataCurrentRound;

	beforeEach(async () => {
		({
			sportsAMMV2Manager,
			sportsAMMV2,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			collateral,
			collateralSixDecimals,
			owner,
			tradeDataCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, secondAccount, firstLiquidityProvider } =
			await loadFixture(deployAccountsFixture));

		// Start liquidity pool
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('removeResolvedTickets', () => {
		it('Should remove resolved tickets from user resolved list', async () => {
			// Set result type
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			// Create and execute first trade
			tradeDataCurrentRound[0].position = 0;
			const quote1 = await sportsAMMV2.tradeQuote(
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
					quote1.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// Create and execute second trade
			const quote2 = await sportsAMMV2.tradeQuote(
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
					quote2.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			expect(activeTickets.length).to.equal(2);
			const firstTicketAddress = activeTickets[0];
			const secondTicketAddress = activeTickets[1];

			// Resolve tickets by setting results
			const ticketMarket = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket.gameId],
				[ticketMarket.typeId],
				[ticketMarket.playerId],
				[[0]]
			);

			// Exercise tickets to resolve them
			await sportsAMMV2.connect(firstTrader).handleTicketResolving(firstTicketAddress, 0);
			await sportsAMMV2.connect(firstTrader).handleTicketResolving(secondTicketAddress, 0);

			// Verify tickets are resolved
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(2);
			const resolvedTicketsBefore = await sportsAMMV2Manager.getResolvedTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(resolvedTicketsBefore.length).to.equal(2);
			expect(resolvedTicketsBefore[0]).to.equal(firstTicketAddress);
			expect(resolvedTicketsBefore[1]).to.equal(secondTicketAddress);

			// Remove resolved tickets
			await sportsAMMV2Manager
				.connect(owner)
				.removeResolvedTickets([firstTicketAddress, secondTicketAddress], firstTrader);

			// Verify tickets are removed from resolved list
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(0);
			const resolvedTicketsAfter = await sportsAMMV2Manager.getResolvedTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(resolvedTicketsAfter.length).to.equal(0);
		});

		it('Should remove only specified tickets from resolved list', async () => {
			// Set result type
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			// Create three tickets
			tradeDataCurrentRound[0].position = 0;
			for (let i = 0; i < 3; i++) {
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
			}

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			expect(activeTickets.length).to.equal(3);
			const firstTicketAddress = activeTickets[0];
			const secondTicketAddress = activeTickets[1];
			const thirdTicketAddress = activeTickets[2];

			// Resolve tickets
			const ticketMarket = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket.gameId],
				[ticketMarket.typeId],
				[ticketMarket.playerId],
				[[0]]
			);

			// Exercise all tickets
			await sportsAMMV2.connect(firstTrader).handleTicketResolving(firstTicketAddress, 0);
			await sportsAMMV2.connect(firstTrader).handleTicketResolving(secondTicketAddress, 0);
			await sportsAMMV2.connect(firstTrader).handleTicketResolving(thirdTicketAddress, 0);

			// Verify all tickets are resolved
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(3);

			// Remove only first two tickets
			await sportsAMMV2Manager
				.connect(owner)
				.removeResolvedTickets([firstTicketAddress, secondTicketAddress], firstTrader);

			// Verify only the third ticket remains in resolved list
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(1);
			const resolvedTicketsAfter = await sportsAMMV2Manager.getResolvedTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(resolvedTicketsAfter.length).to.equal(1);
			expect(resolvedTicketsAfter[0]).to.equal(thirdTicketAddress);
		});

		it('Should revert when called by non-owner and non-whitelisted address', async () => {
			// Set result type
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			// Create and resolve a ticket
			tradeDataCurrentRound[0].position = 0;
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

			// Resolve ticket
			const ticketMarket = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket.gameId],
				[ticketMarket.typeId],
				[ticketMarket.playerId],
				[[0]]
			);

			await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

			// Try to remove tickets as non-owner / non-whitelisted
			await expect(
				sportsAMMV2Manager
					.connect(secondAccount)
					.removeResolvedTickets([ticketAddress], firstTrader)
			).to.be.revertedWith('Invalid resolver');
		});

		it('Should allow whitelisted MARKET_RESOLVING address to remove resolved tickets', async () => {
			// Whitelist secondAccount for MARKET_RESOLVING role
			const MARKET_RESOLVING_ROLE = 2; // ISportsAMMV2Manager.Role.MARKET_RESOLVING
			await sportsAMMV2Manager
				.connect(owner)
				.setWhitelistedAddresses([secondAccount.address], MARKET_RESOLVING_ROLE, true);

			// Set result type
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			// Create and resolve a ticket
			tradeDataCurrentRound[0].position = 0;
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

			// Resolve ticket
			const ticketMarket = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket.gameId],
				[ticketMarket.typeId],
				[ticketMarket.playerId],
				[[0]]
			);

			await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(1);

			// Whitelisted address removes resolved ticket
			await sportsAMMV2Manager
				.connect(secondAccount)
				.removeResolvedTickets([ticketAddress], firstTrader);

			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(0);
		});

		it('Should handle empty ticket array', async () => {
			// Should not revert when removing empty array
			await expect(sportsAMMV2Manager.connect(owner).removeResolvedTickets([], firstTrader)).to.not
				.be.reverted;
		});

		it('Should revert when trying to remove tickets that are not in resolved list', async () => {
			// Set result type
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			// Create a ticket but don't resolve it
			tradeDataCurrentRound[0].position = 0;
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

			// Verify no resolved tickets
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(0);

			// Try to remove a ticket that's not resolved - should revert
			await expect(
				sportsAMMV2Manager.connect(owner).removeResolvedTickets([ticketAddress], firstTrader)
			).to.be.revertedWith('Element not in set.');

			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.equal(0);
		});
	});
});
