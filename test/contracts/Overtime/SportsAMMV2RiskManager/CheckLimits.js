const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2RiskManager Check Limits', () => {
	let sportsAMMV2RiskManager,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('5000'));
		await sportsAMMV2LiquidityPool.start();
		await sportsAMMV2LiquidityPool.setUtilizationRate(ethers.parseEther('1'));
	});

	describe('Ticket inside limits', () => {
		it('Should pass with one market on ticket', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await expect(
				sportsAMMV2RiskManager.checkLimits(
					BUY_IN_AMOUNT,
					quote.totalQuote,
					quote.payout,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					10
				)
			).to.not.be.reverted;
		});

		it('Should pass with 10 markets on ticket', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await expect(
				sportsAMMV2RiskManager.checkLimits(
					BUY_IN_AMOUNT,
					quote.totalQuote,
					quote.payout,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					10
				)
			).to.not.be.reverted;
		});
	});

	describe('Ticket outside limits', () => {
		let quote;

		beforeEach(async () => {
			quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
		});

		it('Should fail with "Low buy-in amount"', async () => {
			await expect(
				sportsAMMV2RiskManager.checkLimits(
					0,
					quote.totalQuote,
					quote.payout,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					10
				)
			).to.be.revertedWith('LowBuyin');
		});

		it('Should fail with "Exceeded max ticket size"', async () => {
			await expect(
				sportsAMMV2RiskManager.checkLimits(
					BUY_IN_AMOUNT,
					quote.totalQuote,
					quote.payout,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					11
				)
			).to.be.revertedWith('ExceededMaxSize');
		});

		it('Should fail with "Exceeded max supported odds"', async () => {
			await expect(
				sportsAMMV2RiskManager.checkLimits(
					BUY_IN_AMOUNT,
					ethers.parseEther('0.001'),
					quote.payout,
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					10
				)
			).to.be.revertedWith('ExceededMaxOdds');
		});

		it('Should fail with "Exceeded max supported amount"', async () => {
			await expect(
				sportsAMMV2RiskManager.checkLimits(
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ethers.parseEther('100000'),
					quote.payout,
					ADDITIONAL_SLIPPAGE,
					10
				)
			).to.be.revertedWith('ExceededMaxAmount');
		});

		it('Should fail with "Slippage too high"', async () => {
			await expect(
				sportsAMMV2RiskManager.checkLimits(
					BUY_IN_AMOUNT,
					quote.totalQuote,
					quote.payout,
					ethers.parseEther('1000'),
					ADDITIONAL_SLIPPAGE,
					10
				)
			).to.be.revertedWith('SlippageHigh');
		});
	});
});
