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

	it('Should return correct maxStake and availableLiquidity for all traded markets, including a custom one', async () => {
		const markets = [...tradeDataTenMarketsCurrentRound.slice(0, 9)];

		// Modify the 10th market manually
		const customMarket = {
			gameId: markets[0].gameId,
			sportId: 4,
			typeId: 5, // different type
			playerId: 9, // different player
			line: 0,
			maturity: markets[0].maturity,
			isLive: false,
			position: 1, // different position
			odds: ethers.parseUnits('0.75', 18), // different odds
		};

		const inputs = markets.map((trade, i) => {
			console.log(
				`\n[Input #${i}] GameID: ${trade.gameId}, TypeID: ${trade.typeId}, PlayerID: ${
					trade.playerId
				}, Position: ${trade.position}, Odds: ${ethers.formatEther(trade.odds[trade.position])}`
			);
			return {
				gameId: trade.gameId,
				sportId: 4,
				typeId: trade.typeId,
				playerId: trade.playerId,
				line: trade.line,
				maturity: trade.maturity,
				isLive: false,
				position: trade.position,
				odds: trade.odds[trade.position],
			};
		});

		// Append the custom market
		inputs.push(customMarket);

		const [maxStakes, availableLiquidity] =
			await sportsAMMV2Data.getMaxStakeAndLiquidityBatch(inputs);

		expect(maxStakes.length).to.equal(10);
		expect(availableLiquidity.length).to.equal(10);

		console.log('\n[Results]');
		for (let i = 0; i < 10; i++) {
			const odds = ethers.formatEther(inputs[i].odds);
			const stake = ethers.formatEther(maxStakes[i]);
			const liquidity = ethers.formatEther(availableLiquidity[i]);
			const isCustom = i === 9 ? ' (custom)' : '';
			console.log(`Market #${i}${isCustom}`);
			console.log(`- Odds: ${odds}`);
			console.log(`- Available Liquidity: ${liquidity} USD`);
			console.log(`- Max Stake Returned: ${stake} USD`);

			expect(availableLiquidity[i]).to.be.gt(0);
			expect(maxStakes[i]).to.be.gt(0);
		}

		// Ensure the custom market has different output
		expect(maxStakes[9]).to.not.equal(maxStakes[0]);
		expect(availableLiquidity[9]).to.not.equal(availableLiquidity[0]);
	});
});
