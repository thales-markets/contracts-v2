const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('SportsAMMV2Data - Max Stake and Liquidity', () => {
	let sportsAMMV2Data,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataTenMarketsCurrentRound,
		firstTrader,
		firstLiquidityProvider;

	beforeEach(async () => {
		({ sportsAMMV2Data, sportsAMMV2, sportsAMMV2LiquidityPool, tradeDataTenMarketsCurrentRound } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

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

	it('Should correctly return maxStake and liquidity for alternating positions of a single market', async () => {
		const baseTrade = tradeDataTenMarketsCurrentRound[0];

		const inputs = [];

		// Simulate 5 positions for the same game/type/player
		for (let position = 0; position < 5; position++) {
			inputs.push({
				gameId: baseTrade.gameId,
				sportId: 4,
				typeId: baseTrade.typeId,
				playerId: baseTrade.playerId,
				line: baseTrade.line,
				maturity: baseTrade.maturity,
				isLive: false,
				position,
				odds: ethers.parseUnits((0.8 + position * 0.03).toFixed(2), 18), // 0.80, 0.83, ..., 0.92
			});
		}

		// Simulate spending some risk on game (optional)
		const quote = await sportsAMMV2.tradeQuote([baseTrade], BUY_IN_AMOUNT, ZERO_ADDRESS, false);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				[baseTrade],
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const [maxStakes, availableLiquidity] =
			await sportsAMMV2Data.getMaxStakeAndLiquidityBatch(inputs);

		expect(maxStakes.length).to.equal(inputs.length);
		expect(availableLiquidity.length).to.equal(inputs.length);

		console.log('\n[Alternating Positions]');
		for (let i = 0; i < inputs.length; i++) {
			const odds = ethers.formatEther(inputs[i].odds);
			const stake = ethers.formatEther(maxStakes[i]);
			const liquidity = ethers.formatEther(availableLiquidity[i]);

			console.log(`Position #${inputs[i].position}`);
			console.log(`- Odds: ${odds}`);
			console.log(`- Available Liquidity: ${liquidity} USD`);
			console.log(`- Max Stake Returned: ${stake} USD`);

			expect(availableLiquidity[i]).to.be.gt(0);
			expect(maxStakes[i]).to.be.gt(0);
		}

		// Optional: ensure different positions return different values
		for (let i = 1; i < inputs.length; i++) {
			expect(maxStakes[i]).to.not.equal(maxStakes[0]);
			expect(availableLiquidity[i]).to.not.equal(availableLiquidity[0]);
		}
	});
});
