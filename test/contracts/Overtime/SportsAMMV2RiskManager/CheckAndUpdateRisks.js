const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');
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
		tradeDataNotActive,
		liveTradingProcessor,
		mockChainlinkOracle,
		collateral,
		quote;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			sameGameDifferentPlayersDifferentProps,
			tradeDataNotActive,
			liveTradingProcessor,
			mockChainlinkOracle,
			collateral,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, firstLiquidityProvider } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('5000'));
		await sportsAMMV2LiquidityPool.start();
		await sportsAMMV2LiquidityPool.setUtilizationRate(ethers.parseEther('1'));

		await collateral.connect(firstTrader).approve(sportsAMMV2.target, ethers.MaxUint256);
		await collateral.connect(firstTrader).approve(liveTradingProcessor.target, ethers.MaxUint256);

		quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, ZERO_ADDRESS, false);
	});

	describe('Update risks', () => {
		it('Should update risks (risk per market type and position, spent on game)', async () => {
			const formattedBuyInAmount = Number(ethers.formatEther(BUY_IN_AMOUNT));
			const formattedOdds0 = Number(ethers.formatEther(tradeDataCurrentRound[0].odds[0]));
			const formattedOdds1 = Number(ethers.formatEther(tradeDataCurrentRound[0].odds[1]));
			const marketRisk0 = formattedBuyInAmount / formattedOdds0 - formattedBuyInAmount;

			let tradeQuote = await sportsAMMV2.tradeQuote(
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
					tradeQuote.totalQuote,
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
			expect(Number(ethers.formatEther(positionRisk1))).to.equal(-formattedBuyInAmount);
			expect(Number(ethers.formatEther(spentOnGame))).to.equal(marketRisk0);

			const newBuyInAmount = ethers.parseEther('5');
			const formattedNewBuyInAmount = Number(ethers.formatEther(newBuyInAmount));
			const marketRisk1 = formattedNewBuyInAmount / formattedOdds1 - formattedNewBuyInAmount;

			tradeDataCurrentRound[0].position = 1;
			tradeQuote = await sportsAMMV2.tradeQuote(
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
					tradeQuote.totalQuote,
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

			const expectedPositionRisk0 = marketRisk0 - formattedNewBuyInAmount;
			const expectedPositionRisk1 = -formattedBuyInAmount + marketRisk1;
			const expectedSpent = marketRisk0 + marketRisk1;

			expect(Number(ethers.formatEther(positionRisk0)).toFixed(4)).to.equal(
				expectedPositionRisk0.toFixed(4)
			);
			expect(Number(ethers.formatEther(positionRisk1)).toFixed(4)).to.equal(
				expectedPositionRisk1.toFixed(4)
			);
			expect(Number(ethers.formatEther(spentOnGame)).toFixed(4)).to.equal(expectedSpent.toFixed(4));
		});

		it('Should only update live risk up to position + 2 and not touch later positions', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(
				tradeDataCurrentRound[0].sportId,
				tradeDataCurrentRound[0].typeId,
				true
			);

			const singleQuote = await sportsAMMV2.tradeQuote(
				[tradeDataTenMarketsCurrentRound[0]],
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);

			// Must match LiveTradingProcessor.stringToBytes32(_gameId)
			const gameId = ethers.hexlify(
				ethers.zeroPadBytes(ethers.toUtf8Bytes(tradeDataCurrentRound[0].gameId).slice(0, 32), 32)
			);
			const typeId = tradeDataCurrentRound[0].typeId;
			const playerId = tradeDataCurrentRound[0].playerId;

			const createAndFulfillLiveTrade = async (position, buyInAmount = BUY_IN_AMOUNT) => {
				const requestIndex = await liveTradingProcessor.requestCounter();

				await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
					_gameId: tradeDataCurrentRound[0].gameId,
					_sportId: tradeDataCurrentRound[0].sportId,
					_typeId: tradeDataCurrentRound[0].typeId,
					_line: tradeDataCurrentRound[0].line,
					_position: position,
					_buyInAmount: buyInAmount,
					_expectedQuote: singleQuote.totalQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
					_playerId: playerId,
				});

				const requestId = await liveTradingProcessor.counterToRequestId(requestIndex);
				await mockChainlinkOracle.fulfillLiveTrade(requestId, true, singleQuote.totalQuote);
			};

			// Seed position outside future bounded loop
			await createAndFulfillLiveTrade(20);

			const position20RiskSeeded = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				gameId,
				typeId,
				playerId,
				20
			);
			expect(position20RiskSeeded).to.be.gt(0);

			// Seed position inside future bounded loop
			await createAndFulfillLiveTrade(11);

			const position11RiskBefore = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				gameId,
				typeId,
				playerId,
				11
			);
			expect(position11RiskBefore).to.be.gt(0);

			const position20RiskBefore = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				gameId,
				typeId,
				playerId,
				20
			);
			expect(position20RiskBefore).to.equal(position20RiskSeeded);

			// position 10 => live loop touches 0..12, so 11 should change, 20 should not
			const thirdBuyInAmount = ethers.parseEther('5');
			await createAndFulfillLiveTrade(10, thirdBuyInAmount);

			const position10RiskAfter = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				gameId,
				typeId,
				playerId,
				10
			);
			const position11RiskAfter = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				gameId,
				typeId,
				playerId,
				11
			);
			const position20RiskAfter = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				gameId,
				typeId,
				playerId,
				20
			);

			expect(position10RiskAfter).to.be.gt(0);
			expect(position11RiskAfter).to.equal(position11RiskBefore - thirdBuyInAmount);
			expect(position20RiskAfter).to.equal(position20RiskBefore);
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
					BUY_IN_AMOUNT,
					false,
					0,
					false
				)
			).to.be.revertedWith('OnlyAMMAllowed');
		});

		it('Should fail with "Invalid position"', async () => {
			const tradeQuote = await sportsAMMV2.tradeQuote(
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
						tradeQuote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWithCustomError(sportsAMMV2, 'InvalidPosition');
		});

		it('Should fail with "Not trading"', async () => {
			let tradeQuote = await sportsAMMV2.tradeQuote(
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
						tradeQuote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'MarketNotTrading');

			await time.increase((await time.latest()) + ONE_WEEK_IN_SECS);

			tradeQuote = await sportsAMMV2.tradeQuote(
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
						tradeQuote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWithCustomError(sportsAMMV2, 'IllegalInputAmounts');
		});

		it('Should fail with "Risk per market and position exceeded"', async () => {
			const buyInAmount = ethers.parseEther('1000');

			const tradeQuote = await sportsAMMV2.tradeQuote(
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
						tradeQuote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'ExceededMarketPositionRisk');
		});

		it('Should fail with "Risk per game exceeded"', async () => {
			const buyInAmount = ethers.parseEther('1000');

			let tradeQuote = await sportsAMMV2.tradeQuote(
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
					tradeQuote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			for (let i = 0; i < tradeDataTenMarketsCurrentRound.length; i++) {
				tradeDataTenMarketsCurrentRound[i].position = 1;
			}

			tradeQuote = await sportsAMMV2.tradeQuote(
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
						tradeQuote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'ExceededGameRisk');
		});

		it('Should fail with "Invalid combination detected"', async () => {
			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			const tradeQuote = await sportsAMMV2.tradeQuote(
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
						tradeQuote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						ZERO_ADDRESS,
						ZERO_ADDRESS,
						false
					)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidCombination');
		});
	});
});
