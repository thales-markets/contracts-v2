const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');

const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, RESULT_TYPE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('Ticket Cashout Quote (Ticket.getCashoutQuoteAndPayout)', () => {
	const ONE = 10n ** 18n;

	const mul1e18 = (a, b) => (a * b) / ONE;
	const div1e18 = (a, b) => (a * ONE) / b;

	// pow(x, n) for 1e18 fixed point
	const pow1e18 = (x, n) => {
		let r = ONE;
		for (let i = 0; i < n; i++) r = mul1e18(r, x);
		return r;
	};

	const absDiff = (a, b) => (a > b ? a - b : b - a);

	const expectApprox = (actual, expected, tol, label = '') => {
		const d = absDiff(actual, expected);
		expect(d, `${label} diff=${d.toString()}`).to.lte(tol);
	};

	async function buyParlayAndGetTicket({ sportsAMMV2, sportsAMMV2Manager, firstTrader, legs }) {
		const quote = await sportsAMMV2.tradeQuote(legs, BUY_IN_AMOUNT, ZERO_ADDRESS, false);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				legs,
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		const TicketContract = await ethers.getContractFactory('Ticket');
		return TicketContract.attach(ticketAddress);
	}

	// IMPORTANT: your new rule is "2x vig for single remaining leg" which,
	// with your compounding implementation, means exponent = remainingLegs + 1.
	// Also: you said you set cashout fee multiplier to 4, so v = safeBoxFee * 4.
	async function getPerLegVig1e18(sportsAMMV2) {
		const safeBoxFee = BigInt((await sportsAMMV2.safeBoxFee()).toString()); // 1e18
		const multiplier = 4n; // <-- you changed this from 5 to 4
		const v = safeBoxFee * multiplier; // 1e18 fraction
		return { safeBoxFee, multiplier, v };
	}

	it('1) pending-only: cashoutQuote & payout follow (orig/live ratio) with compounded vig (+1 exponent rule)', async () => {
		const {
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture);

		const { firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];

		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs,
		});

		const leg0 = BigInt((await ticket.getMarketOdd(0)).toString());
		const leg1 = BigInt((await ticket.getMarketOdd(1)).toString());

		const approvedOddsPerLeg = [leg0, leg1];
		const isLegSettled = [false, false];

		const res = await ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
		const cashoutQuote = BigInt(res[0].toString());
		const payoutAfterFee = BigInt(res[1].toString());

		const buyIn = BigInt(BUY_IN_AMOUNT.toString());

		// ratio=1 => rawPayout=buyIn (since approved odds == stored odds and all pending)
		const rawPayout = buyIn;

		const { v } = await getPerLegVig1e18(sportsAMMV2);

		const remainingLegs = 2; // 2 pending legs
		// New rule implemented via compounding: keep = (1 - v)^(remainingLegs + 1)
		const keepFactor = pow1e18(ONE - v, remainingLegs + 1);

		const expectedPayout = mul1e18(rawPayout, keepFactor);
		const expectedQuote = div1e18(expectedPayout, buyIn);

		expect(payoutAfterFee).to.eq(expectedPayout);
		expect(cashoutQuote).to.eq(expectedQuote);
	});

	it('2) rejects lying isLegSettled after cancel (must match onchain state)', async () => {
		const {
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2ResultManager,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture);

		const { firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];

		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs,
		});

		const m0 = legs[0];
		await sportsAMMV2ResultManager.cancelMarket(m0.gameId, m0.typeId, m0.playerId || 0, m0.line);

		const leg0 = BigInt((await ticket.getMarketOdd(0)).toString());
		const leg1 = BigInt((await ticket.getMarketOdd(1)).toString());
		const approvedOddsPerLeg = [leg0, leg1];

		await expect(
			ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, [false, false])
		).to.be.revertedWith('Invalid isLegSettled');

		await expect(ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, [true, false])).to.not.be
			.reverted;
	});

	it('3) one-won-one-pending: won leg treated as 1, only pending leg repriced, vig applies with remaining=1 (+1 exponent rule)', async () => {
		const {
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2ResultManager,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture);

		const { firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];
		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs,
		});

		// Make sure result type for typeId=0 is set
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

		// Resolve FIRST leg as WON (set result = the chosen position)
		const m0 = legs[0];
		await sportsAMMV2ResultManager.setResultsPerMarkets(
			[m0.gameId],
			[m0.typeId],
			[m0.playerId || 0],
			[[m0.position]]
		);

		const leg0Stored = BigInt((await ticket.getMarketOdd(0)).toString());
		const leg1Stored = BigInt((await ticket.getMarketOdd(1)).toString());

		const approvedOddsPerLeg = [leg0Stored, leg1Stored]; // deterministic: same as stored
		const isLegSettled = [true, false];

		const res = await ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
		const cashoutQuote = BigInt(res[0].toString());
		const payoutAfterFee = BigInt(res[1].toString());

		// ---- expected (match contract math) ----
		const buyIn = BigInt(BUY_IN_AMOUNT.toString());

		// origProbTotal = leg0 * leg1
		const origProbTotal = mul1e18(leg0Stored, leg1Stored);

		// liveProbTotal: won leg => ONE, pending => leg1
		const liveProbTotal = leg1Stored;

		// raw payout = buyIn * (live/orig)
		const ratio = div1e18(liveProbTotal, origProbTotal);
		const rawPayout = mul1e18(buyIn, ratio);

		const { v } = await getPerLegVig1e18(sportsAMMV2);

		const remainingLegs = 1;
		// New rule via compounding: keep = (1 - v)^(remainingLegs + 1) = (1 - v)^2
		const keepFactor = pow1e18(ONE - v, remainingLegs + 1);

		const expectedPayout = mul1e18(rawPayout, keepFactor);
		const expectedQuote = div1e18(expectedPayout, buyIn);

		// small rounding dust tolerance (integer division)
		const TOL = 10n;

		expectApprox(payoutAfterFee, expectedPayout, TOL, 'payoutAfterFee');
		expectApprox(cashoutQuote, expectedQuote, TOL, 'cashoutQuote');
	});

	it('4) getCashoutDataForLeg reverts before ticket is cashed out', async () => {
		const {
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture);

		const { firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];

		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs,
		});

		await expect(ticket.getCashoutDataForLeg(0)).to.be.revertedWith('Ticket not cashed out');
	});

	it('5) stores approved cashout odds and settled flags per leg on successful cashout', async () => {
		const {
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture);

		const { owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];

		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs,
		});

		await sportsAMMV2
			.connect(owner)
			.setBettingProcessors(
				await sportsAMMV2.liveTradingProcessor(),
				await sportsAMMV2.sgpTradingProcessor(),
				await sportsAMMV2.freeBetsHolder(),
				owner.address
			);

		const storedLeg0 = await ticket.getMarketOdd(0);
		const storedLeg1 = await ticket.getMarketOdd(1);

		const approvedOddsPerLeg = [(storedLeg0 * 101n) / 100n, (storedLeg1 * 99n) / 100n];
		const isLegSettled = [false, false];

		await sportsAMMV2
			.connect(owner)
			.cashoutTicketWithLegOdds(
				ticket.target,
				approvedOddsPerLeg,
				isLegSettled,
				firstTrader.address
			);

		expect(await ticket.cashedOut()).to.eq(true);

		const [approvedOdd0, wasSettled0] = await ticket.getCashoutDataForLeg(0);
		const [approvedOdd1, wasSettled1] = await ticket.getCashoutDataForLeg(1);

		expect(approvedOdd0).to.eq(approvedOddsPerLeg[0]);
		expect(wasSettled0).to.eq(false);

		expect(approvedOdd1).to.eq(approvedOddsPerLeg[1]);
		expect(wasSettled1).to.eq(false);
	});
});
