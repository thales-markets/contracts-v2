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

	describe('Update risks', () => {
		it('Should update risks (risk per market type and position, spent on game)', async () => {
			const formattedBuyInAmount = Number(ethers.formatEther(BUY_IN_AMOUNT));
			const formattedOdds0 = Number(ethers.formatEther(tradeDataCurrentRound[0].odds[0]));
			const formattedOdds1 = Number(ethers.formatEther(tradeDataCurrentRound[0].odds[1]));
			const marketRisk0 = formattedBuyInAmount / formattedOdds0 - formattedBuyInAmount;

			let quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

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

			let positionRisk0 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataCurrentRound[0].gameId,
				tradeDataCurrentRound[0].typeId,
				tradeDataCurrentRound[0].playerId,
				0
			);
			let positionRisk1 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataCurrentRound[0].gameId,
				tradeDataCurrentRound[0].typeId,
				tradeDataCurrentRound[0].playerId,
				1
			);
			let spentOnGame = await sportsAMMV2RiskManager.spentOnGame(tradeDataCurrentRound[0].gameId);

			expect(Number(ethers.formatEther(positionRisk0))).to.equal(marketRisk0);
			expect(Number(ethers.formatEther(positionRisk1))).to.equal(-marketRisk0);
			expect(Number(ethers.formatEther(spentOnGame))).to.equal(marketRisk0);

			const newBuyInAmount = ethers.parseEther('5');
			const formattedNewBuyInAmount = Number(ethers.formatEther(newBuyInAmount));
			const marketRisk1 = formattedNewBuyInAmount / formattedOdds1 - formattedNewBuyInAmount;

			tradeDataCurrentRound[0].position = 1;
			quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				newBuyInAmount,
				ZERO_ADDRESS,
				false
			);

			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					newBuyInAmount,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			positionRisk0 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataCurrentRound[0].gameId,
				tradeDataCurrentRound[0].typeId,
				tradeDataCurrentRound[0].playerId,
				0
			);
			positionRisk1 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				tradeDataCurrentRound[0].gameId,
				tradeDataCurrentRound[0].typeId,
				tradeDataCurrentRound[0].playerId,
				1
			);
			spentOnGame = await sportsAMMV2RiskManager.spentOnGame(tradeDataCurrentRound[0].gameId);

			expect(Number(ethers.formatEther(positionRisk0)).toFixed(4)).to.equal(
				(marketRisk0 - marketRisk1).toFixed(4)
			);
			expect(Number(ethers.formatEther(positionRisk1)).toFixed(4)).to.equal(
				(-marketRisk0 + marketRisk1).toFixed(4)
			);
			expect(Number(ethers.formatEther(spentOnGame)).toFixed(4)).to.equal(
				(marketRisk0 + marketRisk1).toFixed(4)
			);
		});
	});

	describe('Ticket with risks', () => {
		beforeEach(() => {
			for (let i = 0; i < tradeDataTenMarketsCurrentRound.length; i++) {
				tradeDataTenMarketsCurrentRound[i].position = 0;
			}
		});

		it('Should fail with "Only the AMM may perform these methods"', async () => {
			await expect(
				sportsAMMV2RiskManager.checkAndUpdateRisks(
					tradeDataTenMarketsCurrentRound,
					BUY_IN_AMOUNT,
					false
				)
			).to.be.revertedWith('Only the AMM may perform these methods');
		});

		it('Should fail with "Invalid position"', async () => {
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			tradeDataTenMarketsCurrentRound[0].position = 3;
			await expect(
				sportsAMMV2
					.connect(firstTrader)
					.trade(
						tradeDataTenMarketsCurrentRound,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWith('Invalid position');
		});

		it('Should fail with "Not trading"', async () => {
			let quote = await sportsAMMV2.tradeQuote(
				tradeDataNotActive,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await expect(
				sportsAMMV2
					.connect(firstTrader)
					.trade(
						tradeDataNotActive,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWith('Not trading');

			await time.increase((await time.latest()) + ONE_WEEK_IN_SECS);

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await expect(
				sportsAMMV2
					.connect(firstTrader)
					.trade(
						tradeDataTenMarketsCurrentRound,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWith('Illegal input amounts');
		});

		it('Should fail with "Risk per market and position exceeded"', async () => {
			const buyInAmount = ethers.parseEther('1000');

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				buyInAmount,
				ZERO_ADDRESS,
				false
			);

			await sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
				ethers.parseEther('10'),
				3
			);

			await expect(
				sportsAMMV2
					.connect(firstTrader)
					.trade(
						tradeDataTenMarketsCurrentRound,
						buyInAmount,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWith('Risk per market and position exceeded');
		});

		it('Should fail with "Risk per game exceeded"', async () => {
			const buyInAmount = ethers.parseEther('1000');

			let quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				buyInAmount,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataTenMarketsCurrentRound,
					buyInAmount,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			for (let i = 0; i < tradeDataTenMarketsCurrentRound.length; i++) {
				tradeDataTenMarketsCurrentRound[i].position = 1;
			}

			quote = await sportsAMMV2.tradeQuote(
				tradeDataTenMarketsCurrentRound,
				buyInAmount,
				ZERO_ADDRESS,
				false
			);

			await sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
				ethers.parseEther('200'),
				1
			);

			await expect(
				sportsAMMV2
					.connect(firstTrader)
					.trade(
						tradeDataTenMarketsCurrentRound,
						buyInAmount,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWith('Risk per game exceeded');
		});

		it('Should fail with "Invalid combination detected"', async () => {
			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			const quote = await sportsAMMV2.tradeQuote(
				sameGameDifferentPlayersDifferentProps,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, false);

			await expect(
				sportsAMMV2
					.connect(firstTrader)
					.trade(
						sameGameDifferentPlayersDifferentProps,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWith('Invalid combination detected');
		});
	});
});
