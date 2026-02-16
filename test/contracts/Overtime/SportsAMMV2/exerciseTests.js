const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, RESULT_TYPE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 — expectedFinalPayout', () => {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2THALESLiquidityPool,
		tradeDataCurrentRound,
		collateralTHALES,
		collateralTHALESAddress,
		firstLiquidityProvider,
		firstTrader;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2THALESLiquidityPool,
			tradeDataCurrentRound,
			collateralTHALES,
			collateralTHALESAddress,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		// fund & start pools
		await sportsAMMV2THALESLiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2THALESLiquidityPool.start();
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	it('sets expectedFinalPayout = payout + fees on ticket creation and uses it on exercise', async () => {
		// 1) Get quote in THALES
		const quoteTHALES = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			BUY_IN_AMOUNT,
			collateralTHALESAddress,
			false
		);
		const expectedPayout = quoteTHALES.payout; // amount user should receive upon win (excl. fees)
		const expectedFees = quoteTHALES.fees;
		const expectedPayoutWithFees = expectedPayout + expectedFees;

		// 2) Execute trade
		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				quoteTHALES.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				collateralTHALESAddress,
				false
			);

		// 3) Resolve market as a win
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
		await sportsAMMV2ResultManager.setResultsPerMarkets(
			[tradeDataCurrentRound[0].gameId],
			[tradeDataCurrentRound[0].typeId],
			[tradeDataCurrentRound[0].playerId],
			[[0]] // correct position
		);

		// 4) Fetch the ticket
		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];
		const TicketFactory = await ethers.getContractFactory('Ticket');
		const ticket = await TicketFactory.attach(ticketAddress);

		// 5) Check expectedFinalPayout committed on Ticket
		const committed = await ticket.expectedFinalPayout();
		expect(committed).to.equal(expectedPayoutWithFees);

		// 6) Capture user balance before exercise
		const userBalBefore = await collateralTHALES.balanceOf(firstTrader.address);

		// 7) Exercise via AMM
		await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

		// 8) User should receive exactly "payout" (not payout+fees)
		const userBalAfter = await collateralTHALES.balanceOf(firstTrader.address);
		expect(userBalAfter - userBalBefore).to.equal(expectedPayout);

		// 9) Ticket should be swept (no leftovers)
		expect(await collateralTHALES.balanceOf(ticketAddress)).to.equal(0n);
	});

	it('ignores manual top-ups to Ticket and still pays only the expected payout', async () => {
		// 1) Quote and trade
		const quoteTHALES = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			BUY_IN_AMOUNT,
			collateralTHALESAddress,
			false
		);
		const expectedPayout = quoteTHALES.payout;
		const expectedFees = quoteTHALES.fees;
		const expectedPayoutWithFees = expectedPayout + expectedFees;

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				quoteTHALES.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				collateralTHALESAddress,
				false
			);

		// Resolve as win
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
		await sportsAMMV2ResultManager.setResultsPerMarkets(
			[tradeDataCurrentRound[0].gameId],
			[tradeDataCurrentRound[0].typeId],
			[tradeDataCurrentRound[0].playerId],
			[[0]]
		);

		// Fetch ticket
		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];
		const TicketFactory = await ethers.getContractFactory('Ticket');
		const ticket = await TicketFactory.attach(ticketAddress);

		// Sanity: expectedFinalPayout committed
		expect(await ticket.expectedFinalPayout()).to.equal(expectedPayoutWithFees);

		// 2) Attacker manually tops up the Ticket before resolve
		// ensure the trader has enough THALES
		await collateralTHALES.mintForUser(firstTrader.address);

		// mintForUser usually gives a big balance, but just in case:
		const maliciousTopUp = ethers.parseEther('123');
		await collateralTHALES.connect(firstTrader).transfer(ticketAddress, maliciousTopUp);

		// (optional sanity)
		let ticketBalBefore = await collateralTHALES.balanceOf(ticketAddress);
		expect(ticketBalBefore).to.be.gte(expectedPayoutWithFees + maliciousTopUp);

		// 3) Capture balances
		const userBalBefore = await collateralTHALES.balanceOf(firstTrader.address);
		ticketBalBefore = await collateralTHALES.balanceOf(ticketAddress);
		expect(ticketBalBefore).to.be.greaterThan(expectedPayoutWithFees); // top-up landed

		// 4) Exercise
		await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

		// 5) User still only gets "payout" (fees and any top-ups are not paid to user)
		const userBalAfter = await collateralTHALES.balanceOf(firstTrader.address);
		expect(userBalAfter - userBalBefore).to.equal(expectedPayout);

		// 6) Ticket must be swept; any leftovers (incl. maliciousTopUp + fees) end up away from Ticket
		expect(await collateralTHALES.balanceOf(ticketAddress)).to.equal(0n);

		// Optional (uncomment if you want to assert AMM sweep-to-pool flow):
		// After Ticket.sweep -> funds go to AMM, then AMM.transferToPool(...) zeroes its own balance for this ticket.
		// We can at least assert AMM holds no residual from this ticket address path:
		expect(await collateralTHALES.balanceOf(sportsAMMV2.target)).to.equal(0n);
	});
});
