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
	ADDITIONAL_SLIPPAGE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('Ticket Exercise and Expire', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2ResultManager,
		tradeDataCurrentRound,
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

	describe('Exercise and expire', () => {
		it('Exercise market', async () => {
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
			// console.log(userTicket);
			expect(await userTicket.isTicketExercisable()).to.be.equal(true);
			expect(await userTicket.isUserTheWinner()).to.be.equal(true);
			const phase = await userTicket.phase();
			expect(phase).to.be.equal(1);
			await sportsAMMV2.exerciseTicket(ticketAddress);
			expect(await userTicket.resolved()).to.be.equal(true);
		});

		it('Expire market', async () => {
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
			const activeTickets = await sportsAMMV2.getActiveTickets(0, 100);
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
});
