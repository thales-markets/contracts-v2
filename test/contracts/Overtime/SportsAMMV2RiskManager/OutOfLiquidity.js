const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, RISK_STATUS, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2RiskManager Out Of Liquidity', () => {
	let sportsAMMV2RiskManager,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstTrader,
		firstLiquidityProvider;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('5000'));
		await sportsAMMV2LiquidityPool.start();
		await sportsAMMV2LiquidityPool.setUtilizationRate(ethers.parseEther('1'));
	});

	describe('Ticket with liquidity', () => {
		it('Should pass with one market on ticket', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});
		it('Should pass with 10 markets on ticket', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});
	});

	describe('Ticket with out of liquidity', () => {
		it('Should fail for all markets on ticket (market cap exceeded)', async () => {
			const buyInAmount = ethers.parseEther('1000');

			await sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
				ethers.parseEther('10'),
				3
			);

			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				buyInAmount
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.OutOfLiquidity);
			for (let i = 0; i < checkRisksData.isMarketOutOfLiquidity.length; i++) {
				expect(checkRisksData.isMarketOutOfLiquidity[i]).to.equal(true);
			}
		});

		it('Should fail for all markets on ticket (game cap exceeded)', async () => {
			const buyInAmount = ethers.parseEther('1000');

			await sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
				ethers.parseEther('200'),
				1
			);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				buyInAmount,
				ZERO_ADDRESS
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					buyInAmount,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			for (let i = 0; i < tradeDataTenMarketsCurrentRound.length; i++) {
				tradeDataTenMarketsCurrentRound[i].position = 1;
			}

			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				buyInAmount
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.OutOfLiquidity);
			for (let i = 0; i < checkRisksData.isMarketOutOfLiquidity.length; i++) {
				expect(checkRisksData.isMarketOutOfLiquidity[i]).to.equal(true);
			}
		});

		it('Should fail for one market (market cap exceeded)', async () => {
			const buyInAmount = ethers.parseEther('1000');
			const outOfLiquidityMarketIndex = 5;

			await sportsAMMV2RiskManager.setCapsPerMarket(
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].gameId],
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].typeId],
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].playerId],
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].line],
				[ethers.parseEther('10')]
			);

			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				buyInAmount
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.OutOfLiquidity);
			for (let i = 0; i < checkRisksData.isMarketOutOfLiquidity.length; i++) {
				if (i == outOfLiquidityMarketIndex) {
					expect(checkRisksData.isMarketOutOfLiquidity[i]).to.equal(true);
				} else {
					expect(checkRisksData.isMarketOutOfLiquidity[i]).to.equal(false);
				}
			}
		});

		it('Should fail for one market (game cap exceeded)', async () => {
			const buyInAmount = ethers.parseEther('1000');
			const outOfLiquidityMarketIndex = 5;

			await sportsAMMV2RiskManager.setCapsPerMarket(
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].gameId],
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].typeId],
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].playerId],
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].line],
				[ethers.parseEther('200')]
			);
			await sportsAMMV2RiskManager.setRiskMultipliersPerGame(
				[tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].gameId],
				[1]
			);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				buyInAmount,
				ZERO_ADDRESS
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					buyInAmount,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			tradeDataTenMarketsCurrentRound[outOfLiquidityMarketIndex].position = 1;

			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				buyInAmount
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.OutOfLiquidity);
			for (let i = 0; i < checkRisksData.isMarketOutOfLiquidity.length; i++) {
				if (i == outOfLiquidityMarketIndex) {
					expect(checkRisksData.isMarketOutOfLiquidity[i]).to.equal(true);
				} else {
					expect(checkRisksData.isMarketOutOfLiquidity[i]).to.equal(false);
				}
			}
		});
	});
});
