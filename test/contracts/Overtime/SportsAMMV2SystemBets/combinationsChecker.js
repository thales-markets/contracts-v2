const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, SPORT_ID_NBA } = require('../../../constants/overtime');
const { ZERO_ADDRESS, ONE_WEEK_IN_SECS } = require('../../../constants/general');

describe('SportsAMMV2RiskManager Check And Update Risks', () => {
	let sportsAMMV2RiskManager,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		sameGameDifferentPlayersDifferentProps,
		firstTrader,
		firstLiquidityProvider,
		tradeDataNotActive;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			sameGameDifferentPlayersDifferentProps,
			tradeDataNotActive,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('5000'));
		await sportsAMMV2LiquidityPool.start();
		await sportsAMMV2LiquidityPool.setUtilizationRate(ethers.parseEther('1'));
	});

	describe('Check combinations generations', () => {
		it('It should generate 3/5 combinations for system bets as expected)', async () => {
			let generatedCombinations = await sportsAMMV2RiskManager.generateCombinations(5, 3);
			expect(generatedCombinations.length).to.equal(10);
			expect(generatedCombinations[0][0]).to.equal(0);
			expect(generatedCombinations[0][1]).to.equal(1);
			expect(generatedCombinations[0][2]).to.equal(2);
		});

		it('It should generate 7/10 combinations for system bets as expected)', async () => {
			let generatedCombinations = await sportsAMMV2RiskManager.generateCombinations(10, 7);
			expect(generatedCombinations.length).to.equal(120);
			expect(generatedCombinations[119][0]).to.equal(3);
			expect(generatedCombinations[119][1]).to.equal(4);
			expect(generatedCombinations[119][2]).to.equal(5);
			expect(generatedCombinations[119][3]).to.equal(6);
			expect(generatedCombinations[119][4]).to.equal(7);
			expect(generatedCombinations[119][5]).to.equal(8);
			expect(generatedCombinations[119][6]).to.equal(9);
		});

		it('Should revert if systemBetDenominator is not a proper value)', async () => {
			await expect(
				sportsAMMV2RiskManager.generateCombinations(10, 10)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'BadRangeForK');

			await expect(
				sportsAMMV2RiskManager.generateCombinations(10, 11)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'BadRangeForK');

			await expect(
				sportsAMMV2RiskManager.generateCombinations(10, 1)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'BadRangeForK');
		});
	});
});
