const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Quote', () => {
		it('Should get quote', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));
		});
	});

	describe('Trade', () => {
		it('Should buy a ticket (1 market)', async () => {
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

			const roots = await sportsAMMV2.getRootsPerGames([tradeDataCurrentRound[0].gameId]);
			expect(roots.length).to.be.greaterThan(0);
		});

		it('Should buy a ticket (10 markets)', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal('28679719907924413133');

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

			const roots = await sportsAMMV2.getRootsPerGames([
				tradeDataTenMarketsCurrentRound[0].gameId,
				tradeDataTenMarketsCurrentRound[1].gameId,
			]);
			expect(roots.length).to.be.greaterThan(1);
		});

		it('Should buy a ticket (1 market) with referrer', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			expect(quote.payout).to.equal(ethers.parseEther('20'));

			await sportsAMMV2.connect(firstTrader).trade(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				firstLiquidityProvider, //referrer
				ZERO_ADDRESS,
				false
			);
		});
	});
});
