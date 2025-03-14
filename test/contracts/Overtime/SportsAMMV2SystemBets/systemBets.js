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
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		tradeDataThreeMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		collateral,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		defaultLiquidityProviderAddress,
		defaultLiquidityProvider;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			tradeDataThreeMarketsCurrentRound,
			collateral,
			sportsAMMV2ResultManager,
			defaultLiquidityProvider,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		defaultLiquidityProviderAddress = await defaultLiquidityProvider.getAddress();

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade', () => {
		it('Should buy a system ticket (2/3 markets)', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataThreeMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal('42735042735042735042');

			const maxSystemBetPayoutAndQuote = await sportsAMMV2RiskManager.getMaxSystemBetPayout(
				tradeDataThreeMarketsCurrentRound,
				2,
				BUY_IN_AMOUNT,
				0
			);

			// console.log('odds0: ' + tradeDataThreeMarketsCurrentRound[0].odds[0] / 1e18); // 0.52 or 1.923 decimal
			// console.log('odds1: ' + tradeDataThreeMarketsCurrentRound[1].odds[0] / 1e18); // 0.5 or 2 decimal
			// console.log('odds2: ' + tradeDataThreeMarketsCurrentRound[2].odds[0] / 1e18); // 0.9 or 1.111 decimal

			expect(maxSystemBetPayoutAndQuote.systemBetPayout).to.equal('27350427350427350423');

			await sportsAMMV2
				.connect(firstTrader)
				.tradeSystemBet(
					tradeDataThreeMarketsCurrentRound,
					BUY_IN_AMOUNT,
					maxSystemBetPayoutAndQuote.systemBetQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false,
					2
				);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.isSystem()).to.be.equal(true);

			const ticketBalance = await collateral.balanceOf(ticketAddress);
			expect(ticketBalance).to.equal(ethers.parseEther('27.550427350427350423'));

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
			expect(systemBetPayout).to.be.equal('7407407407407407406');

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			const defaultLiquidityProviderAddressBefore = await collateral.balanceOf(
				defaultLiquidityProviderAddress
			);

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			const defaultLiquidityProviderAddressAfter = await collateral.balanceOf(
				defaultLiquidityProviderAddress
			);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('9997.407407407407407406'));

			expect(defaultLiquidityProviderAddressBefore).to.be.equal(
				ethers.parseEther('9982.449572649572649577')
			);
			expect(defaultLiquidityProviderAddressAfter).to.be.equal(
				ethers.parseEther('10002.392592592592592594')
			);

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});

		it('Should fail to buy a ticket with over max number of combinations', async () => {
			await sportsAMMV2RiskManager.setTicketParams(
				3 * 1e6,
				15,
				20000 * 1e6,
				ethers.parseEther('0.01'),
				100 // max combinations
			);

			await expect(
				sportsAMMV2RiskManager.getMaxSystemBetPayout(
					tradeDataTenMarketsCurrentRound,
					5,
					BUY_IN_AMOUNT,
					0
				)
			).to.be.revertedWith('ExceededMaxCombinations');
		});
	});
});
