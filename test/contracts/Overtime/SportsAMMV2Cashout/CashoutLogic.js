const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
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

	async function getPerLegVig1e18(sportsAMMV2) {
		const safeBoxFee = BigInt((await sportsAMMV2.safeBoxFee()).toString());
		const multiplier = 4n;
		const v = safeBoxFee * multiplier;
		return { safeBoxFee, multiplier, v };
	}

	async function getCashoutCooldown(sportsAMMV2) {
		const riskManagerAddress = await sportsAMMV2.riskManager();
		const RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
		const riskManager = RiskManager.attach(riskManagerAddress);
		return BigInt((await riskManager.getCashoutCooldown()).toString());
	}

	async function setOwnerAsCashoutProcessor({ sportsAMMV2, owner }) {
		await sportsAMMV2
			.connect(owner)
			.setBettingProcessors(
				await sportsAMMV2.liveTradingProcessor(),
				await sportsAMMV2.sgpTradingProcessor(),
				await sportsAMMV2.freeBetsHolder(),
				owner.address
			);
	}

	async function moveToExactCashoutTimestamp({ ticket, sportsAMMV2 }) {
		const createdAt = BigInt((await ticket.createdAt()).toString());
		const cooldown = await getCashoutCooldown(sportsAMMV2);
		await time.increaseTo(createdAt + cooldown);
		return { createdAt, cooldown };
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
		const rawPayout = buyIn;

		const { v } = await getPerLegVig1e18(sportsAMMV2);

		const remainingLegs = 2;
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

		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

		const m0 = legs[0];
		await sportsAMMV2ResultManager.setResultsPerMarkets(
			[m0.gameId],
			[m0.typeId],
			[m0.playerId || 0],
			[[m0.position]]
		);

		const leg0Stored = BigInt((await ticket.getMarketOdd(0)).toString());
		const leg1Stored = BigInt((await ticket.getMarketOdd(1)).toString());

		const approvedOddsPerLeg = [leg0Stored, leg1Stored];
		const isLegSettled = [true, false];

		const res = await ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
		const cashoutQuote = BigInt(res[0].toString());
		const payoutAfterFee = BigInt(res[1].toString());

		const buyIn = BigInt(BUY_IN_AMOUNT.toString());

		const origProbTotal = mul1e18(leg0Stored, leg1Stored);
		const liveProbTotal = leg1Stored;

		const ratio = div1e18(liveProbTotal, origProbTotal);
		const rawPayout = mul1e18(buyIn, ratio);

		const { v } = await getPerLegVig1e18(sportsAMMV2);

		const remainingLegs = 1;
		const keepFactor = pow1e18(ONE - v, remainingLegs + 1);

		const expectedPayout = mul1e18(rawPayout, keepFactor);
		const expectedQuote = div1e18(expectedPayout, buyIn);

		const TOL = 10n;

		expectApprox(payoutAfterFee, expectedPayout, TOL, 'payoutAfterFee');
		expectApprox(cashoutQuote, expectedQuote, TOL, 'cashoutQuote');
	});

	it('4) getCashoutPerLegData reverts before ticket is cashed out', async () => {
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

		await expect(ticket.getCashoutPerLegData()).to.be.revertedWith('Ticket not cashed out');
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

		await setOwnerAsCashoutProcessor({ sportsAMMV2, owner });

		await moveToExactCashoutTimestamp({ ticket, sportsAMMV2 });

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

		const [storedApprovedOdds, storedSettledFlags] = await ticket.getCashoutPerLegData();

		expect(storedApprovedOdds.length).to.eq(2);
		expect(storedSettledFlags.length).to.eq(2);

		expect(storedApprovedOdds[0]).to.eq(approvedOddsPerLeg[0]);
		expect(storedSettledFlags[0]).to.eq(false);

		expect(storedApprovedOdds[1]).to.eq(approvedOddsPerLeg[1]);
		expect(storedSettledFlags[1]).to.eq(false);
	});

	it('6) quote can still be fetched during cooldown (cooldown is enforced only on execution)', async () => {
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

		const leg0 = await ticket.getMarketOdd(0);
		const leg1 = await ticket.getMarketOdd(1);

		await expect(ticket.getCashoutQuoteAndPayout([leg0, leg1], [false, false])).to.not.be.reverted;
	});

	it('7) cashout reverts during cooldown', async () => {
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

		await setOwnerAsCashoutProcessor({ sportsAMMV2, owner });

		const storedLeg0 = await ticket.getMarketOdd(0);
		const storedLeg1 = await ticket.getMarketOdd(1);

		const approvedOddsPerLeg = [storedLeg0, storedLeg1];
		const isLegSettled = [false, false];

		await expect(
			sportsAMMV2
				.connect(owner)
				.cashoutTicketWithLegOdds(
					ticket.target,
					approvedOddsPerLeg,
					isLegSettled,
					firstTrader.address
				)
		).to.be.revertedWith('Not possible during cooldown');
	});

	it('8) cashout reverts at cooldown - 1 and succeeds exactly at cooldown timestamp', async () => {
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

		await setOwnerAsCashoutProcessor({ sportsAMMV2, owner });

		const storedLeg0 = await ticket.getMarketOdd(0);
		const storedLeg1 = await ticket.getMarketOdd(1);

		const approvedOddsPerLeg = [storedLeg0, storedLeg1];
		const isLegSettled = [false, false];

		const createdAt = BigInt((await ticket.createdAt()).toString());
		const cooldown = await getCashoutCooldown(sportsAMMV2);

		if (cooldown > 0n) {
			await time.setNextBlockTimestamp(createdAt + cooldown - 1n);

			await expect(
				sportsAMMV2
					.connect(owner)
					.cashoutTicketWithLegOdds(
						ticket.target,
						approvedOddsPerLeg,
						isLegSettled,
						firstTrader.address
					)
			).to.be.revertedWith('Not possible during cooldown');
		}

		await time.setNextBlockTimestamp(createdAt + cooldown);

		await expect(
			sportsAMMV2
				.connect(owner)
				.cashoutTicketWithLegOdds(
					ticket.target,
					approvedOddsPerLeg,
					isLegSettled,
					firstTrader.address
				)
		).to.not.be.reverted;

		expect(await ticket.cashedOut()).to.eq(true);
	});
	it('9) cashout respects updated cashout cooldown of 10 minutes', async () => {
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

		const riskManagerAddress = await sportsAMMV2.riskManager();
		const RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
		const riskManager = RiskManager.attach(riskManagerAddress);

		const tenMinutes = 10 * 60;
		await riskManager.connect(owner).setCashoutCooldown(tenMinutes);

		expect(await riskManager.getCashoutCooldown()).to.eq(tenMinutes);

		const legs = [tradeDataTenMarketsCurrentRound[0], tradeDataTenMarketsCurrentRound[1]];

		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs,
		});

		await setOwnerAsCashoutProcessor({ sportsAMMV2, owner });

		const storedLeg0 = await ticket.getMarketOdd(0);
		const storedLeg1 = await ticket.getMarketOdd(1);

		const approvedOddsPerLeg = [storedLeg0, storedLeg1];
		const isLegSettled = [false, false];

		const createdAt = BigInt((await ticket.createdAt()).toString());
		const cooldown = BigInt((await riskManager.getCashoutCooldown()).toString());

		await time.setNextBlockTimestamp(createdAt + cooldown - 1n);

		await expect(
			sportsAMMV2
				.connect(owner)
				.cashoutTicketWithLegOdds(
					ticket.target,
					approvedOddsPerLeg,
					isLegSettled,
					firstTrader.address
				)
		).to.be.revertedWith('Not possible during cooldown');

		await time.setNextBlockTimestamp(createdAt + cooldown);

		await expect(
			sportsAMMV2
				.connect(owner)
				.cashoutTicketWithLegOdds(
					ticket.target,
					approvedOddsPerLeg,
					isLegSettled,
					firstTrader.address
				)
		).to.not.be.reverted;

		expect(await ticket.cashedOut()).to.eq(true);
	});

	it('10) cashout on default-round deferred ticket pulls funds from default LP', async () => {
		const {
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataCrossRounds,
			collateral,
			safeBox,
		} = await loadFixture(deploySportsAMMV2Fixture);

		const { owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const ticket = await buyParlayAndGetTicket({
			sportsAMMV2,
			sportsAMMV2Manager,
			firstTrader,
			legs: tradeDataCrossRounds,
		});

		await setOwnerAsCashoutProcessor({ sportsAMMV2, owner });
		await moveToExactCashoutTimestamp({ ticket, sportsAMMV2 });

		const leg0 = await ticket.getMarketOdd(0);
		const leg1 = await ticket.getMarketOdd(1);
		const approvedOddsPerLeg = [leg0, leg1];
		const isLegSettled = [false, false];

		const res = await ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
		const cashoutAmount = res[1];

		const sportsAMMV2UtilsAddress = await sportsAMMV2.sportsAMMV2Utils();
		const SportsAMMV2Utils = await ethers.getContractFactory('SportsAMMV2Utils');
		const sportsAMMV2Utils = SportsAMMV2Utils.attach(sportsAMMV2UtilsAddress);
		const safeBoxFee = await sportsAMMV2.safeBoxFee();
		const expectedFees = await sportsAMMV2Utils.getFees(BUY_IN_AMOUNT, safeBoxFee);

		const defaultLp = await sportsAMMV2LiquidityPool.defaultLiquidityProvider();
		const lpBalanceBefore = await collateral.balanceOf(defaultLp);
		const userBalanceBefore = await collateral.balanceOf(firstTrader.address);
		const safeBoxBalanceBefore = await collateral.balanceOf(safeBox);

		await sportsAMMV2
			.connect(owner)
			.cashoutTicketWithLegOdds(
				ticket.target,
				approvedOddsPerLeg,
				isLegSettled,
				firstTrader.address
			);

		const lpBalanceAfter = await collateral.balanceOf(defaultLp);
		const userBalanceAfter = await collateral.balanceOf(firstTrader.address);
		const safeBoxBalanceAfter = await collateral.balanceOf(safeBox);
		const ammBalanceAfter = await collateral.balanceOf(sportsAMMV2.target);

		expect(userBalanceAfter - userBalanceBefore).to.eq(cashoutAmount);
		expect(lpBalanceBefore - lpBalanceAfter).to.eq(cashoutAmount + expectedFees);
		expect(safeBoxBalanceAfter - safeBoxBalanceBefore).to.eq(expectedFees);
		expect(ammBalanceAfter).to.eq(0n);
	});
});
