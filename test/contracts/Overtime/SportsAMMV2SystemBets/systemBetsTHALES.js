const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	RESULT_TYPE,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	TYPE_ID_WINNER_TOTAL,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 system bets', () => {
	let sportsAMMV2,
		sportsAMMV2RiskManager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2THALESLiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		tradeDataThreeMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		collateral,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		defaultLiquidityProviderAddress,
		defaultLiquidityProviderTHALES,
		collateralTHALES,
		collateralTHALESAddress;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2THALESLiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			tradeDataThreeMarketsCurrentRound,
			collateral,
			collateralTHALES,
			collateralTHALESAddress,
			sportsAMMV2ResultManager,
			defaultLiquidityProviderTHALES,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		defaultLiquidityProviderAddress = await defaultLiquidityProviderTHALES.getAddress();

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await sportsAMMV2THALESLiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2THALESLiquidityPool.start();
	});

	describe('Trade', () => {
		it('Should buy a system ticket (2/3 markets)', async () => {
			const maxSystemBetPayoutAndQuote = await sportsAMMV2RiskManager.getMaxSystemBetPayout(
				tradeDataThreeMarketsCurrentRound,
				2,
				BUY_IN_AMOUNT,
				ADDITIONAL_SLIPPAGE
			);

			// console.log('odds0: ' + tradeDataThreeMarketsCurrentRound[0].odds[0] / 1e18); // 0.52 or 1.923 decimal
			// console.log('odds1: ' + tradeDataThreeMarketsCurrentRound[1].odds[0] / 1e18); // 0.5 or 2 decimal
			// console.log('odds2: ' + tradeDataThreeMarketsCurrentRound[2].odds[0] / 1e18); // 0.9 or 1.111 decimal

			expect(maxSystemBetPayoutAndQuote.systemBetPayout).to.equal('27774735042735042804');

			await sportsAMMV2
				.connect(firstTrader)
				.tradeSystemBet(
					tradeDataThreeMarketsCurrentRound,
					BUY_IN_AMOUNT,
					maxSystemBetPayoutAndQuote.systemBetQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralTHALESAddress,
					false,
					2
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.isSystem()).to.be.equal(true);

			const ticketBalance = await collateralTHALES.balanceOf(ticketAddress);
			expect(ticketBalance).to.equal(ethers.parseEther('27.974735042735042804'));

			expect(await userTicket.isTicketExercisable()).to.be.equal(false);

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, 11029],
				[
					RESULT_TYPE.ExactPosition,
					RESULT_TYPE.OverUnder,
					RESULT_TYPE.Spread,
					RESULT_TYPE.OverUnder,
				]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[0]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(false);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[0]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(false);
			let systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[2].gameId],
				[tradeDataThreeMarketsCurrentRound[2].typeId],
				[tradeDataThreeMarketsCurrentRound[2].playerId],
				[[0]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(true);

			systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal('7496444444444444469');

			const userBalanceBefore = await collateralTHALES.balanceOf(firstTrader);
			const defaultLiquidityProviderAddressBefore = await collateralTHALES.balanceOf(
				defaultLiquidityProviderAddress
			);

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateralTHALES.balanceOf(firstTrader);

			const defaultLiquidityProviderAddressAfter = await collateralTHALES.balanceOf(
				defaultLiquidityProviderAddress
			);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('9997.496444444444444469'));

			expect(defaultLiquidityProviderAddressBefore).to.be.equal(
				ethers.parseEther('9982.025264957264957196')
			);

			expect(defaultLiquidityProviderAddressAfter).to.be.equal(
				ethers.parseEther('10002.303555555555555531')
			);

			const ticketBalanceAfter = await collateralTHALES.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
	});
});
