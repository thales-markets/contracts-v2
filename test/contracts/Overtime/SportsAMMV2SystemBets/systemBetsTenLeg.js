const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers, network } = require('hardhat');

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

describe('SportsAMMV2 system bets', function () {
	const UNDER_COVERAGE = !!process.env.SOLIDITY_COVERAGE || !!process.env.CI;
	this.timeout(UNDER_COVERAGE ? 180_000 : 40_000);

	let sportsAMMV2,
		sportsAMMV2RiskManager,
		sportsAMMV2LiquidityPool,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		collateral,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataTenMarketsCurrentRound,
			collateral,
			sportsAMMV2ResultManager,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		// Fast mining
		await network.provider.send('evm_setAutomine', [true]);
		await network.provider.send('evm_setIntervalMining', [0]);

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade', () => {
		it('Should buy a system ticket (2/3 markets)', async () => {
			// Keep it light under coverage (3 legs, need 2 to win)
			const legs = UNDER_COVERAGE
				? tradeDataTenMarketsCurrentRound.slice(0, 3)
				: tradeDataTenMarketsCurrentRound;

			const k = UNDER_COVERAGE ? 2 : 5;

			const beforeActive = await sportsAMMV2Manager.getActiveTickets(0, 100);

			const { systemBetQuote } = await sportsAMMV2RiskManager.getMaxSystemBetPayout(
				legs,
				k,
				BUY_IN_AMOUNT,
				0
			);

			await sportsAMMV2
				.connect(firstTrader)
				.tradeSystemBet(
					legs,
					BUY_IN_AMOUNT,
					systemBetQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false,
					k
				);

			const afterActive = await sportsAMMV2Manager.getActiveTickets(0, 100);
			expect(afterActive.length).to.equal(beforeActive.length + 1);

			const ticketAddress = afterActive[0];
			expect(ticketAddress).to.properAddress;

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			expect(await userTicket.isSystem()).to.equal(true);
			expect(await userTicket.isTicketExercisable()).to.equal(false);

			// Set result types once
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, TYPE_ID_WINNER_TOTAL],
				[
					RESULT_TYPE.ExactPosition,
					RESULT_TYPE.OverUnder,
					RESULT_TYPE.Spread,
					RESULT_TYPE.OverUnder,
				]
			);

			// Batch results in a single tx (resolve all legs to index 0)
			const gameIds = legs.map((l) => l.gameId);
			const typeIds = legs.map((l) => l.typeId);
			const playerIds = legs.map((l) => l.playerId);
			const results = legs.map(() => [0]);

			await sportsAMMV2ResultManager.setResultsPerMarkets(gameIds, typeIds, playerIds, results);

			expect(await userTicket.isTicketExercisable()).to.equal(true);
			expect(await userTicket.isUserTheWinner()).to.equal(true);

			await sportsAMMV2.connect(firstTrader).handleTicketResolving(ticketAddress, 0);

			const ticketBalanceAfter = await collateral.balanceOf(ticketAddress);
			expect(ticketBalanceAfter).to.equal(0n);
		});
	});
});
