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
	BUY_IN_AMOUNT_SIX_DECIMALS,
	ADDITIONAL_SLIPPAGE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('Ticket Exercise and Expire', () => {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		sportsAMMV2RiskManager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolSixDecimals,
		defaultLiquidityProviderSixDecimals,
		sportsAMMV2LiquidityPoolSixDecimals2,
		defaultLiquidityProviderSixDecimals2,
		sportsAMMV2LiquidityPoolETH,
		defaultLiquidityProviderETH,
		weth,
		collateral,
		collateral18,
		collateralSixDecimals,
		collateralSixDecimals2,
		multiCollateral,
		positionalManager,
		stakingThales,
		safeBox,
		priceFeed,
		firstLiquidityProvider,
		firstTrader,
		secondAccount,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		collateralAddress;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			sportsAMMV2RiskManager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2LiquidityPoolSixDecimals,
			defaultLiquidityProviderSixDecimals,
			sportsAMMV2LiquidityPoolSixDecimals2,
			defaultLiquidityProviderSixDecimals2,
			sportsAMMV2LiquidityPoolETH,
			defaultLiquidityProviderETH,
			weth,
			collateral,
			collateral18,
			collateralSixDecimals,
			collateralSixDecimals2,
			multiCollateral,
			positionalManager,
			stakingThales,
			priceFeed,
			safeBox,
			tradeDataCurrentRound,
			tradeDataNextRound,
			tradeDataCrossRounds,
			collateralAddress,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));
		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Exercise and expire', () => {
		it('18 decimal - default collateral, 6 decimal - multicollateral buy -> Non-revert with panic on exercise', async () => {
			tradeDataCurrentRound[0].position = 0;
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await stakingThales.setFeeToken(collateral);
			expect(await stakingThales.getFeeTokenDecimals()).to.be.equal(18);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT_SIX_DECIMALS,
				collateralSixDecimals,
				false
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT_SIX_DECIMALS,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					collateralSixDecimals,
					false
				);

			let volumeFirstTrader = await stakingThales.volume(firstTrader);
			expect(volumeFirstTrader).to.be.equal(BUY_IN_AMOUNT);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const balanceSixDecimalsOfTicket = await collateralSixDecimals.balanceOf(ticketAddress);
			const balanceDefaultCollateralOfTicket = await collateral.balanceOf(ticketAddress);

			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			expect(
				await sportsAMMV2.liquidityPoolForCollateral(collateralSixDecimals.target)
			).to.be.equal(ZERO_ADDRESS);

			expect(await userTicket.collateral()).to.be.equal(collateralAddress);

			expect(Number(ethers.formatEther(balanceSixDecimalsOfTicket))).to.be.equal(0);

			expect(await userTicket.isTicketExercisable()).to.be.equal(true);
			expect(await userTicket.isUserTheWinner()).to.be.equal(true);
			const phase = await userTicket.phase();
			expect(phase).to.be.equal(1);
			sportsAMMV2.exerciseTicket(ticketAddress);
		});

		it('Exercise market', async () => {
			tradeDataCurrentRound[0].position = 0;
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

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
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

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

			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			// console.log(userTicket);
			expect(await userTicket.isTicketExercisable()).to.be.equal(true);
			expect(await userTicket.isUserTheWinner()).to.be.equal(true);
			const phase = await userTicket.phase();
			expect(phase).to.be.equal(1);
			await sportsAMMV2.exerciseTicket(ticketAddress);
			expect(await userTicket.resolved()).to.be.equal(true);
		});

		it('Expire market', async () => {
			tradeDataCurrentRound.position = 0;
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

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
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

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
			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			expect(await userTicket.phase()).to.be.equal(0);
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);

			// console.log(userTicket);
			expect(await userTicket.isTicketExercisable()).to.be.equal(true);
			expect(await userTicket.isUserTheWinner()).to.be.equal(true);
			expect(await userTicket.phase()).to.be.equal(1);
			const blockNumBefore = await ethers.provider.getBlockNumber();
			const blockBefore = await ethers.provider.getBlock(blockNumBefore);
			const timestampBefore = blockBefore.timestamp;
			const expireTimestamp = await userTicket.expiry();
			const timeDifference =
				Number(expireTimestamp.toString()) - Number(timestampBefore.toString());
			await time.increase(timeDifference);
			expect(await userTicket.phase()).to.be.equal(1);
			await time.increase(1);
			expect(await userTicket.phase()).to.be.equal(2);
			expect(await sportsAMMV2.expireTickets([ticketAddress]))
				.to.emit(userTicket, 'Expired')
				.withArgs(safeBox.target);
		});
	});
	describe('Ticket Cancellation by Admin', () => {
		it('admin cancel the ticket and refund collateral', async () => {
			tradeDataCurrentRound.position = 0;
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

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
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

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

			// Attach the ticket contract and verify collateral balances
			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);
			const ticketBalance = await collateral.balanceOf(ticketAddress);
			expect(Number(ethers.formatEther(ticketBalance))).to.be.gt(0);

			const payoutAfterCancellation =
				parseInt(ticketBalance.toString()) - parseInt(BUY_IN_AMOUNT.toString());
			const initialTicketOwnerBalance = await collateral.balanceOf(firstTrader);

			const initialAdminBalance = await collateral.balanceOf(safeBox.address);
			const calculatedAdminBalance =
				payoutAfterCancellation + parseInt(initialAdminBalance.toString());
			// Simulate admin canceling the ticket
			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 2, true);
			await expect(userTicket.connect(secondAccount).cancelTicketByAdmin(safeBox.address))
				.to.emit(userTicket, 'Resolved')
				.withArgs(false, true); // Verify that the ticket is resolved and canceled

			// Check the final state of the ticket
			expect(await userTicket.cancelled()).to.be.equal(true);
			expect(await userTicket.resolved()).to.be.equal(true);

			// Verify that collateral is refunded to the ticket owner and the remainder to the beneficiary
			const finalTicketOwnerBalance = await collateral.balanceOf(firstTrader);
			const calculatedBalance =
				parseInt(initialTicketOwnerBalance.toString()) + parseInt(BUY_IN_AMOUNT.toString());
			expect(parseInt(finalTicketOwnerBalance.toString())).to.be.equal(calculatedBalance);

			const finalBeneficiaryBalance = await collateral.balanceOf(safeBox.address);
			expect(parseInt(finalBeneficiaryBalance.toString())).to.be.equal(calculatedAdminBalance);
		});
	});
});
