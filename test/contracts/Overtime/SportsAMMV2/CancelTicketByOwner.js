const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_SPAIN,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('SportsAMMV2 - cancelTicketByOwner', () => {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		owner,
		collateral,
		tradeDataCurrentRound,
		tradeDataThreeMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			collateral,
			tradeDataCurrentRound,
			tradeDataThreeMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	it('Should allow ticket owner to cancel eligible ticket and receive refund minus fee', async () => {
		const quote = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		// Execute trade
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

		// SafeBox fee is 2%, cancellation fee is double (4%)
		const expectedFee = (BUY_IN_AMOUNT * 4n) / 100n;

		// Calculate refund after 4% fee
		const expectedRefundMin = BUY_IN_AMOUNT - expectedFee;

		const balanceBefore = await collateral.balanceOf(firstTrader);

		// Cancel ticket
		const tx = await sportsAMMV2
			.connect(firstTrader)
			.cancelTicketByOwner(ticketAddress, tradeDataCurrentRound);

		const balanceAfter = await collateral.balanceOf(firstTrader);

		const actualRefund = balanceAfter - balanceBefore;

		// Assert that the refund is close to what we expect
		expect(actualRefund).to.be.closeTo(expectedRefundMin, ethers.parseEther('0.001'));
	});

	it('Should revert if someone other than the ticket owner tries to cancel', async () => {
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

		await expect(
			sportsAMMV2
				.connect(firstLiquidityProvider)
				.cancelTicketByOwner(ticketAddress, tradeDataCurrentRound)
		).to.be.revertedWithCustomError(sportsAMMV2, 'OnlyTicketOwner');
	});

	it('Should revert if trying to cancel a system bet ticket', async () => {
		const quoteSystem = await sportsAMMV2.tradeQuoteSystem(
			tradeDataThreeMarketsCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false,
			2 // systemBetDenominator
		);

		await sportsAMMV2
			.connect(firstTrader)
			.tradeSystemBet(
				tradeDataThreeMarketsCurrentRound,
				BUY_IN_AMOUNT,
				quoteSystem.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false,
				2
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		await expect(
			sportsAMMV2
				.connect(firstTrader)
				.cancelTicketByOwner(ticketAddress, tradeDataThreeMarketsCurrentRound)
		).to.be.revertedWithCustomError(sportsAMMV2, 'NonCancelableTicket');
	});

	it('Should revert if FreeBetsHolder is the ticket owner', async () => {
		// Make firstTrader the freeBetsHolder
		await sportsAMMV2.connect(owner).setBettingProcessors(ZERO_ADDRESS, ZERO_ADDRESS, firstTrader);

		const quote = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		// FirstTrader places a bet, acting as the freeBetsHolder
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

		await expect(
			sportsAMMV2.connect(firstTrader).cancelTicketByOwner(ticketAddress, tradeDataCurrentRound)
		).to.be.revertedWithCustomError(sportsAMMV2, 'NonCancelableTicket');
	});
});
