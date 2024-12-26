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
		userTicket,
		ticketAddress;

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
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

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
		ticketAddress = activeTickets[0];

		const TicketContract = await ethers.getContractFactory('Ticket');
		userTicket = await TicketContract.attach(ticketAddress);
		expect(await userTicket.isSystem()).to.be.equal(true);

		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
			[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, 11029],
			[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.Spread, RESULT_TYPE.OverUnder]
		);
	});

	describe('Trade system bet and check payouts for all combinations', () => {
		it('Should buy a system ticket (2/3 markets), first two markets won', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[5000]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[0]]
			);

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
			expect(systemBetPayout).to.be.equal('27350427350427350423');

			const userBalanceBefore = await collateral.balanceOf(firstTrader);

			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('10017.350427350427350423'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
		it('Should buy a system ticket (2/3 markets), first two markets won', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[5000]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[0]]
			);

			let systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[2].gameId],
				[tradeDataThreeMarketsCurrentRound[2].typeId],
				[tradeDataThreeMarketsCurrentRound[2].playerId],
				[[1]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(true);

			systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal('12820512820512820511');

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('10002.820512820512820511'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
		it('Should buy a system ticket (2/3 markets), first and third markets won', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[5000]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[1]]
			);

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
			expect(systemBetPayout).to.be.equal('7122507122507122506');

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('9997.122507122507122506'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
		it('Should buy a system ticket (2/3 markets), two won, one cancelled', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[5000]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[0]]
			);

			let systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			await sportsAMMV2ResultManager.cancelMarkets(
				[tradeDataThreeMarketsCurrentRound[2].gameId],
				[tradeDataThreeMarketsCurrentRound[2].typeId],
				[tradeDataThreeMarketsCurrentRound[2].playerId],
				[0]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(true);

			systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal('25897435897435897432');

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('10015.897435897435897432'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
		it('Should buy a system ticket (2/3 markets), 1 won, two cancelled', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[5000]]
			);

			await sportsAMMV2ResultManager.cancelMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[0]
			);

			let systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			await sportsAMMV2ResultManager.cancelMarkets(
				[tradeDataThreeMarketsCurrentRound[2].gameId],
				[tradeDataThreeMarketsCurrentRound[2].typeId],
				[tradeDataThreeMarketsCurrentRound[2].playerId],
				[0]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(true);

			systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal('16153846153846153843');

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('10006.153846153846153843'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
		it('Should buy a system ticket (2/3 markets), 2 lost, 1 cancelled', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[1]]
			);

			let systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			await sportsAMMV2ResultManager.cancelMarkets(
				[tradeDataThreeMarketsCurrentRound[2].gameId],
				[tradeDataThreeMarketsCurrentRound[2].typeId],
				[tradeDataThreeMarketsCurrentRound[2].playerId],
				[0]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			expect(await userTicket.isUserTheWinner()).to.be.equal(false);

			systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('9990'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
		it('Should buy a system ticket (2/3 markets), 2 lost, 1 unresolved, but user already lost', async () => {
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[0].gameId],
				[tradeDataThreeMarketsCurrentRound[0].typeId],
				[tradeDataThreeMarketsCurrentRound[0].playerId],
				[[0]]
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataThreeMarketsCurrentRound[1].gameId],
				[tradeDataThreeMarketsCurrentRound[1].typeId],
				[tradeDataThreeMarketsCurrentRound[1].playerId],
				[[1]]
			);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);

			let systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			expect(await userTicket.isUserTheWinner()).to.be.equal(false);

			systemBetPayout = await userTicket.getSystemBetPayout();
			expect(systemBetPayout).to.be.equal(0);

			const userBalanceBefore = await collateral.balanceOf(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const userBalanceAfter = await collateral.balanceOf(firstTrader);

			expect(userBalanceBefore).to.be.equal(ethers.parseEther('9990'));
			expect(userBalanceAfter).to.be.equal(ethers.parseEther('9990'));

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.be.equal(0);
		});
	});
});
