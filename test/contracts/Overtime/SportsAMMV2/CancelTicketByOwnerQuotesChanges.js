const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 - cancelTicketByOwner refund logic with MockRiskManager', function () {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2ResultManager,
		referrals,
		safeBox,
		collateral,
		tradeDataCurrentRound,
		firstLiquidityProvider,
		firstTrader;

	beforeEach(async function () {
		const fixture = await loadFixture(deploySportsAMMV2Fixture);
		({
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2ResultManager,
			referrals,
			safeBox,
			collateral,
			tradeDataCurrentRound,
		} = fixture);

		const accounts = await loadFixture(deployAccountsFixture);
		firstLiquidityProvider = accounts.firstLiquidityProvider;
		firstTrader = accounts.firstTrader;

		// Deploy mock RiskManager
		const MockRiskManager = await ethers.getContractFactory('MockRiskManager');
		const mockRiskManager = await MockRiskManager.deploy();
		await mockRiskManager.waitForDeployment();

		// Patch contract addresses to use mock risk manager
		await sportsAMMV2.setAddresses(
			await collateral.getAddress(),
			await sportsAMMV2Manager.getAddress(),
			await mockRiskManager.getAddress(),
			await sportsAMMV2ResultManager.getAddress(),
			await referrals.getAddress(),
			await safeBox.getAddress()
		);

		// Fund the liquidity pool and start it
		await collateral
			.connect(firstLiquidityProvider)
			.approve(await sportsAMMV2LiquidityPool.getAddress(), ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	it('Should refund correctly when odds change after ticket purchase', async function () {
		// Deep copy trade data to avoid mutation of shared fixture
		const localTradeData = JSON.parse(JSON.stringify(tradeDataCurrentRound));

		const oddsBefore = ethers.parseUnits('0.666', 18);
		localTradeData[0].odds[0] = oddsBefore;

		await collateral.connect(firstTrader).approve(await sportsAMMV2.getAddress(), BUY_IN_AMOUNT);

		const quoteBefore = await sportsAMMV2.tradeQuote(
			localTradeData,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		expect(quoteBefore.totalQuote).to.be.below(ethers.parseUnits('1', 18));

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				localTradeData,
				BUY_IN_AMOUNT,
				quoteBefore.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		expect(activeTickets.length).to.be.greaterThan(0);
		const ticketAddress = activeTickets[0];

		// Update odds (better for user)
		const oddsAfter = ethers.parseUnits('0.5', 18);
		localTradeData[0].odds[0] = oddsAfter;

		const quoteAfter = await sportsAMMV2.tradeQuote(
			localTradeData,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		expect(quoteAfter.totalQuote).to.be.below(ethers.parseUnits('1', 18));

		// Refund calculation
		const originalExpectedPayout =
			(BUY_IN_AMOUNT * ethers.parseEther('1')) / quoteBefore.totalQuote;
		const newExpectedPayout = (BUY_IN_AMOUNT * ethers.parseEther('1')) / quoteAfter.totalQuote;

		let baseRefundAmount;
		if (newExpectedPayout >= originalExpectedPayout) {
			baseRefundAmount = (BUY_IN_AMOUNT * originalExpectedPayout) / newExpectedPayout;
		} else {
			baseRefundAmount = BUY_IN_AMOUNT;
		}

		const feeAmount = (baseRefundAmount * 4n) / 100n; // 4% fee
		const expectedRefund = baseRefundAmount - feeAmount;

		const balanceBefore = await collateral.balanceOf(firstTrader.address);

		await sportsAMMV2.connect(firstTrader).cancelTicketByOwner(ticketAddress, localTradeData);

		const balanceAfter = await collateral.balanceOf(firstTrader.address);
		const actualRefund = balanceAfter - balanceBefore;

		console.table([
			{
				'Buy-in (USDC)': ethers.formatEther(BUY_IN_AMOUNT),
				'Old Odds (implied)': ethers.formatUnits(oddsBefore, 18),
				'New Odds (implied)': ethers.formatUnits(oddsAfter, 18),
				'Odds Diff': (
					parseFloat(ethers.formatUnits(oddsBefore, 18)) -
					parseFloat(ethers.formatUnits(oddsAfter, 18))
				).toFixed(6),
				'Expected Refund (USDC)': ethers.formatEther(expectedRefund),
				'Actual Refund (USDC)': ethers.formatEther(actualRefund),
			},
		]);

		expect(actualRefund).to.be.closeTo(
			expectedRefund,
			ethers.parseEther('0.1'),
			'Refund amount mismatch'
		);

		const Ticket = await ethers.getContractFactory('Ticket');
		const ticket = Ticket.attach(ticketAddress);
		expect(await ticket.cancelled()).to.be.true;
	});

	it('Should refund correctly when odds worsen after ticket purchase', async function () {
		// Deep copy trade data
		const localTradeData = JSON.parse(JSON.stringify(tradeDataCurrentRound));

		const oddsBefore = ethers.parseUnits('0.5', 18);
		localTradeData[0].odds[0] = oddsBefore;

		await collateral.connect(firstTrader).approve(await sportsAMMV2.getAddress(), BUY_IN_AMOUNT);

		const quoteBefore = await sportsAMMV2.tradeQuote(
			localTradeData,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		expect(quoteBefore.totalQuote).to.be.below(ethers.parseUnits('1', 18));

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				localTradeData,
				BUY_IN_AMOUNT,
				quoteBefore.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		expect(activeTickets.length).to.be.greaterThan(0);
		const ticketAddress = activeTickets[0];

		// Update odds (worse for user)
		const oddsAfter = ethers.parseUnits('0.666', 18);
		localTradeData[0].odds[0] = oddsAfter;

		const quoteAfter = await sportsAMMV2.tradeQuote(
			localTradeData,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		expect(quoteAfter.totalQuote).to.be.below(ethers.parseUnits('1', 18));

		const originalExpectedPayout =
			(BUY_IN_AMOUNT * ethers.parseEther('1')) / quoteBefore.totalQuote;
		const newExpectedPayout = (BUY_IN_AMOUNT * ethers.parseEther('1')) / quoteAfter.totalQuote;

		let baseRefundAmount;
		if (newExpectedPayout >= originalExpectedPayout) {
			baseRefundAmount = (BUY_IN_AMOUNT * originalExpectedPayout) / newExpectedPayout;
		} else {
			baseRefundAmount = BUY_IN_AMOUNT; // refund full buy-in if odds worsened
		}

		const feeAmount = (baseRefundAmount * 4n) / 100n;
		const expectedRefund = baseRefundAmount - feeAmount;

		const balanceBefore = await collateral.balanceOf(firstTrader.address);

		await sportsAMMV2.connect(firstTrader).cancelTicketByOwner(ticketAddress, localTradeData);

		const balanceAfter = await collateral.balanceOf(firstTrader.address);
		const actualRefund = balanceAfter - balanceBefore;

		const oddsBeforeNum = Number(ethers.formatUnits(oddsBefore, 18));
		const oddsAfterNum = Number(ethers.formatUnits(oddsAfter, 18));
		const oddsDiff = oddsAfterNum - oddsBeforeNum;

		console.table([
			{
				'Buy-in (USDC)': Number(ethers.formatEther(BUY_IN_AMOUNT)).toFixed(6),
				'Old Odds (implied)': oddsBeforeNum.toFixed(6),
				'New Odds (implied)': oddsAfterNum.toFixed(6),
				'Odds Diff': oddsDiff.toFixed(6),
				'Expected Refund (USDC)': Number(ethers.formatEther(expectedRefund)).toFixed(6),
				'Actual Refund (USDC)': Number(ethers.formatEther(actualRefund)).toFixed(6),
			},
		]);

		expect(actualRefund).to.be.closeTo(
			expectedRefund,
			ethers.parseEther('0.1'),
			'Refund amount mismatch'
		);

		const Ticket = await ethers.getContractFactory('Ticket');
		const ticket = Ticket.attach(ticketAddress);
		expect(await ticket.cancelled()).to.be.true;
	});
});
