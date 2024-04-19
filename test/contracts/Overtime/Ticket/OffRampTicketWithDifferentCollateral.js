const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	TYPE_ID_TOTAL,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
	GAME_ID_1,
	GAME_ID_2,
	GAME_ID_3,
	GAME_ID_4,
	BUY_IN_AMOUNT,
	DEFAULT_AMOUNT,
	ADDITIONAL_SLIPPAGE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('Ticket Exercise and Expire', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2ResultManager,
		tradeDataCurrentRound,
		multiCollateral,
		weth,
		collateral,
		collateral18,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		safeBox,
		secondAccount;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2ResultManager,
			safeBox,
			multiCollateral,
			weth,
			collateral,
			collateral18,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Offramp Ticket with different collateral', () => {
		it('Exercise with different collateral market', async () => {
			tradeDataCurrentRound[0].position = 0;
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
			await multiCollateral.setSwapRate(collateral, collateral18, ethers.parseEther('2'));

			// Swap rate set for swaps collateral -> collateral18 and collateral18 -> collateral
			expect(await multiCollateral.swapRate(collateral, collateral18)).to.be.equal(
				ethers.parseEther('2')
			);
			expect(await multiCollateral.swapRate(collateral18, collateral)).to.be.equal(
				ethers.parseEther('0.5')
			);

			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_1, 0, 0)).to.equal(
				false
			);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_1, 0, 0, 0)
			).to.be.revertedWithoutReason();
			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_2, 0, 0)).to.equal(
				false
			);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_2, 0, 0, 0)
			).to.be.revertedWithoutReason();

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);
			let swapAmount = parseInt(quote.payout.toString()) * 2;
			collateral18.transfer(multiCollateral, swapAmount.toString());
			collateral.transfer(multiCollateral, swapAmount.toString());
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.isTicketExercisable()).to.be.equal(true);
			expect(await userTicket.isUserTheWinner()).to.be.equal(true);
			const phase = await userTicket.phase();
			expect(phase).to.be.equal(1);
			let userBalanceBefore = await collateral18.balanceOf(firstTrader);
			expect(userBalanceBefore).to.be.equal(DEFAULT_AMOUNT);
			await expect(sportsAMMV2.exerciseTicketOffRamp(ticketAddress, collateral18, false)).to.be.revertedWith("Caller not the ticket owner");
			await sportsAMMV2.connect(firstTrader).exerciseTicketOffRamp(ticketAddress, collateral18, false);
			expect(await userTicket.resolved()).to.be.equal(true);
			let userBalanceAfter = await collateral18.balanceOf(firstTrader);
			let calculatedBalance =
				parseInt(swapAmount.toString()) + parseInt(userBalanceBefore.toString());
			expect(parseInt(userBalanceAfter.toString())).to.be.equal(calculatedBalance);
		});

		it('Exercise with ETH', async () => {
			tradeDataCurrentRound[0].position = 0;
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
			await multiCollateral.setSwapRate(collateral, weth, ethers.parseEther('2'));

			// Swap rate set for swaps collateral -> collateral18 and collateral18 -> collateral
			expect(await multiCollateral.swapRate(collateral, weth)).to.be.equal(ethers.parseEther('2'));
			expect(await multiCollateral.swapRate(weth, collateral)).to.be.equal(
				ethers.parseEther('0.5')
			);

			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_1, 0, 0)).to.equal(
				false
			);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_1, 0, 0, 0)
			).to.be.revertedWithoutReason();
			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_2, 0, 0)).to.equal(
				false
			);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_2, 0, 0, 0)
			).to.be.revertedWithoutReason();

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);
			let swapAmount = parseInt(quote.payout.toString()) * 2;
			await firstLiquidityProvider.sendTransaction({
				to: multiCollateral.target,
				value: swapAmount.toString(),
			});
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.isTicketExercisable()).to.be.equal(true);
			expect(await userTicket.isUserTheWinner()).to.be.equal(true);
			const phase = await userTicket.phase();
			expect(phase).to.be.equal(1);
			await expect(sportsAMMV2.exerciseTicketOffRamp(ticketAddress, weth, true)).to.be.revertedWith("Caller not the ticket owner");
			let userBalanceBefore = await ethers.provider.getBalance(firstTrader);
			await sportsAMMV2.connect(firstTrader).exerciseTicketOffRamp(ticketAddress, weth, true);
			expect(await userTicket.resolved()).to.be.equal(true);

			let userBalanceAfter = await ethers.provider.getBalance(firstTrader);
			let calculatedBalance =
			parseInt(swapAmount.toString()) + parseInt(userBalanceBefore.toString());
			userBalanceAfter = parseInt(parseInt(userBalanceAfter.toString())/1e15);
			calculatedBalance = parseInt(calculatedBalance/1e15);
			expect(userBalanceAfter).to.be.equal(calculatedBalance);
		});
	});
});
