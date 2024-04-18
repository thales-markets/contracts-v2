const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2LiquidityPoolData Read Data', () => {
	let sportsAMMV2LiquidityPoolData, sportsAMMV2LiquidityPool;

	beforeEach(async () => {
		({ sportsAMMV2LiquidityPoolData, sportsAMMV2LiquidityPool } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

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
});
