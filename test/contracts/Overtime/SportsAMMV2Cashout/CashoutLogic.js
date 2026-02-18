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

	it('1) pending-only: cashoutQuote & payout follow (orig/live ratio) with compounded vig', async () => {
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

		// ratio=1 => rawPayout=buyIn
		const rawPayout = buyIn;

		const safeBoxFee = BigInt((await sportsAMMV2.safeBoxFee()).toString());
		const multiplier = 5n; // cashout multiplier
		const v = safeBoxFee * multiplier; // 1e18 fraction

		const n = 2; // 2 pending legs
		// totalVig = 1 - (1 - v)^n  => payout = raw * (1 - totalVig) = raw * (1 - v)^n
		const keepFactor = pow1e18(ONE - v, n);
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

	it('3) one-won-one-pending: won leg treated as 1, only pending leg repriced, vig applies for remaining=1', async () => {
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

		// Call cashout with:
		// - won leg => isLegSettled=true, approved odd can be anything (ignored in contract when resolved)
		// - pending leg => isLegSettled=false, approved odd used for live pricing
		const leg0Stored = BigInt((await ticket.getMarketOdd(0)).toString());
		const leg1Stored = BigInt((await ticket.getMarketOdd(1)).toString());

		const approvedOddsPerLeg = [leg0Stored, leg1Stored]; // keep same live odd for deterministic
		const isLegSettled = [true, false];

		const res = await ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
		const cashoutQuote = BigInt(res[0].toString());
		const payoutAfterFee = BigInt(res[1].toString());

		// ---- expected (match economic intent; allow tiny rounding dust) ----
		const buyIn = BigInt(BUY_IN_AMOUNT.toString());

		// origProbTotal = leg0 * leg1
		const origProbTotal = mul1e18(leg0Stored, leg1Stored);

		// liveProbTotal: won leg => ONE, pending => leg1
		const liveProbTotal = leg1Stored;

		// raw payout
		const ratio = div1e18(liveProbTotal, origProbTotal);
		const rawPayout = mul1e18(buyIn, ratio);

		// remaining legs = 1 => totalVig = v
		const safeBoxFee = BigInt((await sportsAMMV2.safeBoxFee()).toString());
		const multiplier = 5n;
		const v = safeBoxFee * multiplier;

		// contract does fee via integer division; tiny dust can appear
		const fee = (rawPayout * v) / ONE;
		const expectedPayout = rawPayout - fee;

		const expectedQuote = div1e18(expectedPayout, buyIn);

		// tolerate tiny rounding dust (you’re currently seeing diff=9)
		const TOL = 10n;

		expectApprox(payoutAfterFee, expectedPayout, TOL, 'payoutAfterFee');
		expectApprox(cashoutQuote, expectedQuote, TOL, 'cashoutQuote');
	});
});
