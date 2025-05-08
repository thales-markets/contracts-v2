const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	TYPE_ID_TOTAL,
	RESULT_TYPE,
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('markAsLost Integration with SportsAMMV2LiquidityPool', function () {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		collateral,
		tradeDataCurrentRound,
		firstTrader,
		secondAccount,
		defaultLiquidityProvider;

	beforeEach(async function () {
		({
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			collateral,
			tradeDataCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ firstTrader, defaultLiquidityProvider, secondAccount } =
			await loadFixture(deployAccountsFixture));

		await collateral
			.connect(firstTrader)
			.approve(sportsAMMV2LiquidityPool, ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.connect(firstTrader).deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	it('marks a losing ticket as lost, refunds liquidity, and updates exercised flag', async function () {
		tradeDataCurrentRound[0].position = 1; // force a loss
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

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

		const Ticket = await ethers.getContractFactory('Ticket');
		const userTicket = await Ticket.attach(ticketAddress);

		const ticketMarket = tradeDataCurrentRound[0];
		await sportsAMMV2ResultManager.setResultsPerMarkets(
			[ticketMarket.gameId],
			[ticketMarket.typeId],
			[ticketMarket.playerId],
			[[0]] // user picked 1, result is 0 -> loss
		);

		expect(await userTicket.isUserTheWinner()).to.be.false;
		expect(await userTicket.isTicketExercisable()).to.be.true;

		const round = await sportsAMMV2LiquidityPool.round();
		const roundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(round);
		const roundPoolBalanceBefore = await collateral.balanceOf(roundPoolAddress);

		// Should be false before markAsLost
		expect(await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(round, ticketAddress)).to.be
			.false;

		// Whitelist admin
		await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 2, true);

		// Admin marks as lost
		await expect(sportsAMMV2.connect(secondAccount).markAsLost(ticketAddress))
			.to.emit(userTicket, 'Resolved')
			.withArgs(false, false);

		// Should be true after markAsLost
		expect(await sportsAMMV2LiquidityPool.ticketAlreadyExercisedInRound(round, ticketAddress)).to.be
			.true;

		expect(await userTicket.resolved()).to.be.true;
		expect(await userTicket.cancelled()).to.be.false;

		const roundPoolBalanceAfter = await collateral.balanceOf(roundPoolAddress);
		expect(roundPoolBalanceAfter).to.be.gt(roundPoolBalanceBefore);
	});
});
