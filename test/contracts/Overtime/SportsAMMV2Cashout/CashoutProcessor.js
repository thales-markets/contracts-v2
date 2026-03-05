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
		secondTrader,
		mockChainlinkOracle,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		cashoutProcessor,
		collateral, // used as "LINK" like other processors
		sportsAMMV2RiskManager; // attached from sportsAMMV2.riskManager()

	const ONE = 10n ** 18n;
	const addr = (c) => (c?.target ? c.target : c.address);

	async function deployCashoutProcessorAndWire() {
		const CashoutProcessor = await ethers.getContractFactory('CashoutProcessor');
		const jobSpecId = ethers.hexlify(ethers.randomBytes(32));

		cashoutProcessor = await CashoutProcessor.connect(owner).deploy(
			addr(collateral), // "link"
			addr(mockChainlinkOracle),
			addr(sportsAMMV2),
			jobSpecId,
			0 // paymentAmount = 0 (no ERC677 transferAndCall needed)
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

		await sportsAMMV2.connect(firstTrader).trade(
			legs,
			BUY_IN_AMOUNT,
			quote.totalQuote,
			0, // trade additional slippage not relevant here
			ZERO_ADDRESS,
			ZERO_ADDRESS,
			false
		);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		const TicketContract = await ethers.getContractFactory('Ticket');
		return TicketContract.attach(ticketAddress);
	}

	// helper: 10-leg parlay (use all 10 legs)
	async function buyParlayTicket10Legs() {
		const legs = tradeDataTenMarketsCurrentRound;
		const quote = await sportsAMMV2.tradeQuote(legs, BUY_IN_AMOUNT, ZERO_ADDRESS, false);

		await sportsAMMV2.connect(firstTrader).trade(
			legs,
			BUY_IN_AMOUNT,
			quote.totalQuote,
			0, // trade additional slippage not relevant here
			ZERO_ADDRESS,
			ZERO_ADDRESS,
			false
		);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		const TicketContract = await ethers.getContractFactory('Ticket');
		return TicketContract.attach(ticketAddress);
	}

	async function getLastRequestId() {
		const rc = await cashoutProcessor.requestCounter(); // uint -> bigint in ethers v6
		const idx = rc - 1n;
		return await cashoutProcessor.counterToRequestId(idx);
	}

	async function requestCashout(
		ticket,
		expectedOddsPerLeg,
		isLegResolved,
		additionalSlippage = 0n,
		signer = firstTrader
	) {
		await cashoutProcessor
			.connect(signer)
			.requestCashout(addr(ticket), expectedOddsPerLeg, isLegResolved, additionalSlippage);

		return await getLastRequestId();
	}

	async function ensureExactPositionResultType(typeId) {
		// Avoid "Result type not set"
		await sportsAMMV2ResultManager
			.connect(owner)
			.setResultTypesPerMarketTypes([typeId], [RESULT_TYPE.ExactPosition]);
	}

	async function resolveLegAsWon(market) {
		await ensureExactPositionResultType(market.typeId);
		await sportsAMMV2ResultManager
			.connect(owner)
			.setResultsPerMarkets(
				[market.gameId],
				[market.typeId],
				[market.playerId || 0],
				[[market.position]]
			);
	}

	async function resolveLegAsLost(market) {
		await ensureExactPositionResultType(market.typeId);
		const losingResult = market.position === 0 ? 1 : 0;
		await sportsAMMV2ResultManager
			.connect(owner)
			.setResultsPerMarkets(
				[market.gameId],
				[market.typeId],
				[market.playerId || 0],
				[[losingResult]]
			);
	}

	async function voidLeg(market) {
		await sportsAMMV2ResultManager
			.connect(owner)
			.cancelMarket(market.gameId, market.typeId, market.playerId || 0, market.line);
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

		({ owner, firstLiquidityProvider, firstTrader, secondTrader } =
			await loadFixture(deployAccountsFixture));

		// IMPORTANT: sportsAMMV2.riskManager() is an address, so attach the contract
		sportsAMMV2RiskManager = await ethers.getContractAt(
			'SportsAMMV2RiskManager',
			await sportsAMMV2.riskManager()
		);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await deployCashoutProcessorAndWire();
	});

	// -----------------------------
	// Original happy-path suite
	// -----------------------------

	it('1) happy path: requestCashout + fulfill => ticket cashed out, becomes inactive', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg);

		expect(await sportsAMMV2Manager.isActiveTicket(addr(ticket))).to.equal(false);
	});

	it('2) fulfill allow=false => CashoutNotAllowed (and state not persisted due to revert)', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, false, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'CashoutNotAllowed');

		// revert => no state persisted
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

		// For implied probabilities: "worse for user cashout" = LOWER approved odd.
		// With slippage=0, approved must be >= expected for pending legs.
		const approvedOddsTooLow = [expectedOddsPerLeg[0] - 1n, expectedOddsPerLeg[1]];

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, approvedOddsTooLow)
		).to.be.revertedWithCustomError(cashoutProcessor, 'SlippageTooHigh');
	});

	it('5) leg resolves between request and fulfill => LegStatusMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		const m0 = tradeDataTenMarketsCurrentRound[0];
		await voidLeg(m0); // flips onchain status

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'LegStatusMismatch');
	});

	// -----------------------------
	// Added coverage (request-level)
	// -----------------------------

	it('6) request: ticket=0 => InvalidTicket', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(ZERO_ADDRESS, expectedOddsPerLeg, [false, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'InvalidTicket');
	});

	it('7) request: empty expectedOddsPerLeg => InvalidExpectedOdds', async () => {
		const ticket = await buyParlayTicket2Legs();

		await expect(
			cashoutProcessor.connect(firstTrader).requestCashout(addr(ticket), [], [], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'InvalidExpectedOdds');
	});

	it('8) request: arrays length mismatch => InvalidLegArraysLength', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, [false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'InvalidLegArraysLength');
	});

	it('9) request: expectedOdd=0 => InvalidExpectedOdds', async () => {
		const ticket = await buyParlayTicket2Legs();
		const leg1 = await ticket.getMarketOdd(1);

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), [0, leg1], [false, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'InvalidExpectedOdds');
	});

	it('10) request: NotOwner => NotOwner', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];

		await expect(
			cashoutProcessor
				.connect(secondTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, [false, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'NotOwner');
	});

	it('11) request: lying about isLegResolved after void => LegStatusMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];

		await voidLeg(m0);

		const expectedOddsPerLeg = [ONE, await ticket.getMarketOdd(1)];

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, [false, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'LegStatusMismatch');
	});

	it('12) request: voided leg expected odd must be 1e18 => SettledLegOddMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];

		await voidLeg(m0);

		const leg1 = await ticket.getMarketOdd(1);

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), [ONE - 1n, leg1], [true, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'SettledLegOddMismatch');
	});

	it('13) request: resolved non-void leg expected odd must equal ticket odd => SettledLegOddMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];

		await resolveLegAsWon(m0);

		const leg0Stored = await ticket.getMarketOdd(0);
		const leg1Stored = await ticket.getMarketOdd(1);

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(
					addr(ticket),
					[BigInt(leg0Stored.toString()) + 1n, leg1Stored],
					[true, false],
					0n
				)
		).to.be.revertedWithCustomError(cashoutProcessor, 'SettledLegOddMismatch');
	});

	// -----------------------------
	// NEW: maxSupportedOdds clamp -> TicketNotCashoutable
	// -----------------------------
	it('14) request: max odds clamp (ticket.totalQuote == maxSupportedOdds) => TicketNotCashoutable', async () => {
		// Read existing params, only override maxSupportedOdds
		const minBuyInAmount = await sportsAMMV2RiskManager.minBuyInAmount();
		const maxTicketSize = await sportsAMMV2RiskManager.maxTicketSize();
		const maxSupportedAmount = await sportsAMMV2RiskManager.maxSupportedAmount();
		const maxAllowedSystemCombinations =
			await sportsAMMV2RiskManager.maxAllowedSystemCombinations();

		// Force clamp deterministically: set "min implied prob" to 1e18
		// => any computed totalQuote < 1e18 will be clamped to 1e18
		const forcedMaxSupportedOdds = ONE;

		await sportsAMMV2RiskManager
			.connect(owner)
			.setTicketParams(
				minBuyInAmount,
				maxTicketSize,
				maxSupportedAmount,
				forcedMaxSupportedOdds,
				maxAllowedSystemCombinations
			);

		const ticket = await buyParlayTicket10Legs();

		// sanity: ticket got clamped
		expect(await ticket.totalQuote()).to.equal(forcedMaxSupportedOdds);

		const expectedOddsPerLeg = [];
		const isLegResolved = [];

		for (let i = 0; i < 10; i++) {
			expectedOddsPerLeg.push(await ticket.getMarketOdd(i));
			isLegResolved.push(false);
		}

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, isLegResolved, 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'TicketNotCashoutable');
	});

	// -----------------------------
	// Added coverage (fulfill-level / plumbing)
	// -----------------------------

	it('15) fulfill: approvedOdds length mismatch => InvalidLegArraysLength', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, [false, false], 0n);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, [expectedOddsPerLeg[0]])
		).to.be.revertedWithCustomError(cashoutProcessor, 'InvalidLegArraysLength');
	});

	it('16) fulfill: approvedOdd=0 => InvalidExpectedOdds', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, [false, false], 0n);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, [0, expectedOddsPerLeg[1]])
		).to.be.revertedWithCustomError(cashoutProcessor, 'InvalidExpectedOdds');
	});

	it('17) slippage: additionalSlippage allows small decrease but rejects larger', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const onePct = ethers.parseEther('0.01'); // 1% in 1e18
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, onePct);

		// ok: -0.5% (approved >= expected*(1-1%))
		const approvedOk = [(expectedOddsPerLeg[0] * 995n) / 1000n, expectedOddsPerLeg[1]];

		await expect(mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, approvedOk)).to
			.not.be.reverted;
	});

	it('18) slippage: additionalSlippage=1% but approved -2% => SlippageTooHigh', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const onePct = ethers.parseEther('0.01'); // 1%
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, onePct);

		// too low: -2% (violates approved >= expected*(1-1%))
		const approvedTooLow = [(expectedOddsPerLeg[0] * 98n) / 100n, expectedOddsPerLeg[1]];

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, approvedTooLow)
		).to.be.revertedWithCustomError(cashoutProcessor, 'SlippageTooHigh');
	});

	it('19) fulfill: voided leg approved must be 1e18 => SettledLegOddMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];

		await voidLeg(m0);

		const expectedOddsPerLeg = [ONE, await ticket.getMarketOdd(1)];
		const isLegResolved = [true, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await expect(
			mockChainlinkOracle
				.connect(owner)
				.fulfillCashout(requestId, true, [ONE - 1n, expectedOddsPerLeg[1]])
		).to.be.revertedWithCustomError(cashoutProcessor, 'SettledLegOddMismatch');
	});

	it('20) fulfill: resolved non-void leg approved must equal ticket odd => SettledLegOddMismatch', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];

		await resolveLegAsWon(m0);

		const leg0Stored = await ticket.getMarketOdd(0);
		const leg1Stored = await ticket.getMarketOdd(1);

		const expectedOddsPerLeg = [leg0Stored, leg1Stored];
		const isLegResolved = [true, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await expect(
			mockChainlinkOracle
				.connect(owner)
				.fulfillCashout(requestId, true, [BigInt(leg0Stored.toString()) + 1n, leg1Stored])
		).to.be.revertedWithCustomError(cashoutProcessor, 'SettledLegOddMismatch');
	});

	it('21) oracle plumbing: calling fulfillCashout directly (not oracle) => "Source must be the oracle of the request"', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, [false, false], 0n);

		await expect(
			cashoutProcessor.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWith('Source must be the oracle of the request');
	});

	it('22) paused: requestCashout reverts (OZ Pausable v5 custom error)', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];

		await cashoutProcessor.connect(owner).setPaused(true);

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, [false, false], 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'EnforcedPause');
	});

	it('23) paused: fulfillCashout reverts (OZ Pausable v5 custom error)', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, [false, false], 0n);

		await cashoutProcessor.connect(owner).setPaused(true);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWithCustomError(cashoutProcessor, 'EnforcedPause');
	});

	it('24) fulfill twice: second attempt fails at ChainlinkClient oracle guard ("Source must be the oracle of the request")', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const requestId = await requestCashout(ticket, expectedOddsPerLeg, [false, false], 0n);

		await mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWith('Source must be the oracle of the request');
	});

	it('25) request: getRequestBasics/getRequestArrays reflect stored values pre-fulfill', async () => {
		const ticket = await buyParlayTicket2Legs();
		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];
		const slippage = ethers.parseEther('0.01');

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, slippage);

		const basics = await cashoutProcessor.getRequestBasics(requestId);
		expect(basics.ticket).to.equal(addr(ticket));
		expect(basics.requester).to.equal(firstTrader.address);
		expect(BigInt(basics.additionalSlippage.toString())).to.equal(BigInt(slippage.toString()));
		expect(basics.fulfilled).to.equal(false);
		expect(basics.allow).to.equal(false);

		const arrays = await cashoutProcessor.getRequestArrays(requestId);
		expect(arrays.expectedOddsPerLeg.length).to.equal(2);
		expect(arrays.isLegResolved.length).to.equal(2);
		expect(arrays.approvedOddsPerLeg.length).to.equal(0);

		expect(BigInt(arrays.expectedOddsPerLeg[0].toString())).to.equal(
			BigInt(expectedOddsPerLeg[0].toString())
		);
		expect(BigInt(arrays.expectedOddsPerLeg[1].toString())).to.equal(
			BigInt(expectedOddsPerLeg[1].toString())
		);
		expect(arrays.isLegResolved[0]).to.equal(false);
		expect(arrays.isLegResolved[1]).to.equal(false);
	});

	// -----------------------------
	// Added coverage (AMM / Ticket / LP integration)
	// -----------------------------

	it('26) SportsAMM: only cashoutProcessor can call cashoutTicketWithLegOdds', async () => {
		const ticket = await buyParlayTicket2Legs();
		const approvedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegSettled = [false, false];

		await expect(
			sportsAMMV2
				.connect(owner)
				.cashoutTicketWithLegOdds(
					addr(ticket),
					approvedOddsPerLeg,
					isLegSettled,
					firstTrader.address
				)
		).to.be.revertedWithCustomError(sportsAMMV2, 'OnlyDedicatedProcessor');
	});

	it('27) Ticket gating: if all legs resolved (won) then cashout fulfill reverts "Not in trading phase"', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];
		const m1 = tradeDataTenMarketsCurrentRound[1];

		await resolveLegAsWon(m0);
		await resolveLegAsWon(m1);

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [true, true];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await expect(
			mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg)
		).to.be.revertedWith('Not in trading phase');
	});

	it('28) Losing leg resolved -> requestCashout reverts TicketNotCashoutable', async () => {
		const ticket = await buyParlayTicket2Legs();
		const m0 = tradeDataTenMarketsCurrentRound[0];

		await resolveLegAsLost(m0);

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [true, false];

		await expect(
			cashoutProcessor
				.connect(firstTrader)
				.requestCashout(addr(ticket), expectedOddsPerLeg, isLegResolved, 0n)
		).to.be.revertedWithCustomError(cashoutProcessor, 'TicketNotCashoutable');
	});

	it('29) LP integration: after successful cashout, LP marks ticket exercised in its round', async () => {
		const ticket = await buyParlayTicket2Legs();

		const expectedOddsPerLeg = [await ticket.getMarketOdd(0), await ticket.getMarketOdd(1)];
		const isLegResolved = [false, false];

		const requestId = await requestCashout(ticket, expectedOddsPerLeg, isLegResolved, 0n);

		await mockChainlinkOracle.connect(owner).fulfillCashout(requestId, true, expectedOddsPerLeg);

		const ticketRound = await sportsAMMV2LiquidityPool.getTicketRound(addr(ticket));
		const exercised = await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(
			ticketRound,
			addr(ticket)
		);

		expect(exercised).to.equal(true);
	});
});
