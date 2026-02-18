const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, RESULT_TYPE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('CashoutProcessor (E2E)', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		owner,
		mockChainlinkOracle,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		cashoutProcessor,
		collateral;

	const ONE = 10n ** 18n;
	const addr = (c) => (c?.target ? c.target : c.address);

	async function deployCashoutProcessorAndWire() {
		const CashoutProcessor = await ethers.getContractFactory('CashoutProcessor');
		const jobSpecId = ethers.hexlify(ethers.randomBytes(32));

		cashoutProcessor = await CashoutProcessor.connect(owner).deploy(
			addr(collateral), // "link" like LiveTradingProcessor tests
			addr(mockChainlinkOracle),
			addr(sportsAMMV2),
			jobSpecId,
			0 // paymentAmount
		);
		await cashoutProcessor.waitForDeployment();

		await mockChainlinkOracle.connect(owner).setCashoutProcessor(addr(cashoutProcessor));

		await sportsAMMV2
			.connect(owner)
			.setBettingProcessors(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, addr(cashoutProcessor));
	}

	async function buyParlayTicket2Legs() {
		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];

		const quote = await sportsAMMV2.tradeQuote(legs, BUY_IN_AMOUNT, ZERO_ADDRESS, false);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(legs, BUY_IN_AMOUNT, quote.totalQuote, 0, ZERO_ADDRESS, ZERO_ADDRESS, false);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		const TicketContract = await ethers.getContractFactory('Ticket');
		return TicketContract.attach(ticketAddress);
	}

	async function requestCashout(
		ticket,
		expectedOddsPerLeg,
		isLegResolved,
		additionalSlippage = 0n
	) {
		await cashoutProcessor
			.connect(firstTrader)
			.requestCashout(addr(ticket), expectedOddsPerLeg, isLegResolved, additionalSlippage);

		return await cashoutProcessor.counterToRequestId(0);
	}

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataTenMarketsCurrentRound,
			mockChainlinkOracle,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			collateral,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await deployCashoutProcessorAndWire();
	});

	it('1) happy path: requestCashout + fulfill => ticket cashed out, becomes inactive', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg);

		expect(await sportsAMMV2Manager.isActiveTicket(addr(ticket))).to.equal(false);
	});

	it('2) fulfill allow=false => reverts CashoutNotAllowed (and request not marked fulfilled)', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, false, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'CashoutNotAllowed');

		expect(await cashoutProcessor.requestIdFulfilled(requestId)).to.equal(false);
		expect(await cashoutProcessor.requestIdToFulfillAllowed(requestId)).to.equal(false);
	});

	it('3) timeout: fulfill after maxAllowedExecutionDelay => RequestTimedOut', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		await cashoutProcessor.connect(owner).setMaxAllowedExecutionDelay(1);

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await time.increase(2);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'RequestTimedOut');
	});

	it('4) slippage too high on pending leg => SlippageTooHigh', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		const approvedOddsTooHigh = [expectedOddsPerLeg[0] + 1n, expectedOddsPerLeg[1]];

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, approvedOddsTooHigh)
		).to.be.revertedWithCustomError(cashoutProcessor, 'SlippageTooHigh');
	});

	it('5) leg resolves/voids between request and fulfill => LegStatusMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		const m0 = tradeDataTenMarketsCurrentRound[0];
		await sportsAMMV2ResultManager.cancelMarket(m0.gameId, m0.typeId, m0.playerId || 0, m0.line);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'LegStatusMismatch');
	});

	it('10) fulfill twice => second one reverts (oracle guard)', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg);

		// Second fulfill attempt hits Chainlink oracle guard first
		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWith('Source must be the oracle of the request');
	});

	it('11) paused: requestCashout reverts (Pausable custom error)', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];

		await cashoutProcessor.connect(owner).setPaused(true);

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, [false, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'EnforcedPause');
	});

	it('12) paused: fulfillCashout reverts (Pausable custom error)', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await cashoutProcessor.connect(owner).setPaused(true);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'EnforcedPause');
	});

	it('16) fulfill: resolved non-void leg approved must equal ticket odd => SettledLegOddMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();

		// Match your CashoutLogic tests: set result type first
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

		const m0 = tradeDataTenMarketsCurrentRound[0];

		// Resolve leg0 as WON (non-void)
		await sportsAMMV2ResultManager.setResultsPerMarkets(
			[m0.gameId],
			[m0.typeId],
			[m0.playerId || 0],
			[[m0.position]]
		);

		const odd0 = await ticket.getMarketOdd(0);
		const odd1 = await ticket.getMarketOdd(1);

		// request must pass: resolved non-void expected == ticket odd
		const requestId = await requestCashout(ticket, [odd0, odd1], [true, false], 0n);

		// fulfill with wrong approved odd for resolved non-void leg0
		const badApproved = [odd0 + 1n, odd1];

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, badApproved)
		).to.be.revertedWithCustomError(cashoutProcessor, 'SettledLegOddMismatch');
	});
});
