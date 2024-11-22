const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2LiquidityPoolData Read Data', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPoolData,
		sportsAMMV2LiquidityPool,
		firstTrader,
		firstLiquidityProvider,
		tradeDataTenMarketsCurrentRound;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPoolData,
			sportsAMMV2LiquidityPool,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Sports AMM liquidity pool data', () => {
		it('Should return liquidity pool data', async () => {
			const liquidityPoolData =
				await sportsAMMV2LiquidityPoolData.getLiquidityPoolData(sportsAMMV2LiquidityPool);

			expect(liquidityPoolData.started).to.be.equal(true);
			expect(liquidityPoolData.round).to.be.equal(2);
			expect(liquidityPoolData.totalDeposited).to.be.equal(ethers.parseEther('1000'));
		});

		it('Should return user liquidity pool data', async () => {
			const liquidityPoolData = await sportsAMMV2LiquidityPoolData.getUserLiquidityPoolData(
				sportsAMMV2LiquidityPool,
				firstLiquidityProvider
			);

			expect(liquidityPoolData.balanceCurrentRound).to.be.equal(ethers.parseEther('1000'));
		});
	});

	describe('Sports AMM liquidity pool round tickets data', () => {
		beforeEach(async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);
		});

		it('Should return current round tickets data', async () => {
			const currentRoundTicketsData =
				await sportsAMMV2LiquidityPoolData.getCurrentRoundTicketsData(sportsAMMV2LiquidityPool);

			expect(currentRoundTicketsData.totalTickets).to.be.equal(1);
			expect(currentRoundTicketsData.numOfClosedTickets).to.be.equal(0);
			expect(currentRoundTicketsData.numOfPendingTickets).to.be.equal(1);
			expect(currentRoundTicketsData.pendingTickets.length).to.be.equal(1);
		});

		it('Should return current round tickets', async () => {
			const currentRoundTickets =
				await sportsAMMV2LiquidityPoolData.getCurrentRoundTickets(sportsAMMV2LiquidityPool);

			expect(currentRoundTickets.length).to.be.equal(1);
		});

		it('Should return round tickets', async () => {
			const roundTickets = await sportsAMMV2LiquidityPoolData.getRoundTickets(
				sportsAMMV2LiquidityPool,
				1
			);

			expect(roundTickets.length).to.be.equal(1);
		});
	});
});
