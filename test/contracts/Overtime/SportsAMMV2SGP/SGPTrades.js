const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ETH_BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_NBA,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('SportsAMMV2Live Live Trades', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolETH,
		tradeDataThreeMarketsCurrentRound,
		sameGameWithFirstPlayerProps,
		sameGameWithSecondPlayerProps,
		firstLiquidityProvider,
		firstTrader,
		secondAccount,
		sgpTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		weth,
		quote,
		sportsAMMV2Manager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2LiquidityPoolETH,
			tradeDataThreeMarketsCurrentRound,
			sameGameWithFirstPlayerProps,
			sameGameWithSecondPlayerProps,
			sgpTradingProcessor,
			mockChainlinkOracle,
			weth,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ owner, firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('2000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('SGP Trade', () => {
		let approvedQuote = ethers.parseEther('0.5');
		it('Should revert if not the same game', async () => {
			await expect(
				sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
					_tradeData: tradeDataThreeMarketsCurrentRound,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: approvedQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				})
			).to.be.revertedWith('SGP only possible on the same game');
		});

		it('Should revert if not enabled a SGP trade', async () => {
			await expect(
				sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
					_tradeData: sameGameWithFirstPlayerProps,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: approvedQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				})
			).to.be.revertedWith('SGP trading not enabled on _sportId');
		});

		it('Should buy a SGP trade', async () => {
			await sportsAMMV2RiskManager.setSGPEnabledOnSportIds([SPORT_ID_NBA], true);
			let approvedQuote = ethers.parseEther('0.5');

			let sgpRiskBefore = await sportsAMMV2RiskManager.sgpSpentOnGame(
				sameGameWithFirstPlayerProps[0].gameId
			);

			await sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
				_tradeData: sameGameWithFirstPlayerProps,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: approvedQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);

			await mockChainlinkOracle.fulfillSGPTrade(requestId, true, approvedQuote);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			const marketData = await userTicket.markets(0);

			let sgpRiskAfter = await sportsAMMV2RiskManager.sgpSpentOnGame(
				sameGameWithFirstPlayerProps[0].gameId
			);

			expect(sgpRiskBefore).to.equal(ethers.parseEther('0'));
			expect(sgpRiskAfter).to.equal(ethers.parseEther('10'));
		});

		it('Should fail SGP due to liquidity', async () => {
			await sportsAMMV2RiskManager.setSGPEnabledOnSportIds([SPORT_ID_NBA], true);
			await sportsAMMV2RiskManager.setSGPCapDivider(10);

			let approvedQuote = ethers.parseEther('0.5');

			await sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
				_tradeData: sameGameWithFirstPlayerProps,
				_buyInAmount: ethers.parseEther('500'),
				_expectedQuote: approvedQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);

			await expect(
				mockChainlinkOracle.fulfillSGPTrade(requestId, true, approvedQuote)
			).to.be.revertedWith('SGP Risk per game exceeded');
		});

		it('Check that risk per SGP combo is properly calculated', async () => {
			await sportsAMMV2RiskManager.setSGPEnabledOnSportIds([SPORT_ID_NBA], true);
			await sportsAMMV2RiskManager.setCapsPerSport([SPORT_ID_NBA], [ethers.parseEther('1000')]);

			let approvedQuote = ethers.parseEther('0.5');

			let sgpComboRiskBefore = await sportsAMMV2RiskManager.getSGPCombinationRisk(
				sameGameWithFirstPlayerProps
			);

			await sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
				_tradeData: sameGameWithFirstPlayerProps,
				_buyInAmount: ethers.parseEther('100'),
				_expectedQuote: approvedQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);
			await mockChainlinkOracle.fulfillSGPTrade(requestId, true, approvedQuote);

			let sgpComboRiskAfter = await sportsAMMV2RiskManager.getSGPCombinationRisk(
				sameGameWithFirstPlayerProps
			);
			expect(sgpComboRiskBefore).to.equal(ethers.parseEther('0'));
			expect(sgpComboRiskAfter).to.equal(ethers.parseEther('100'));

			let spentOnGame = await sportsAMMV2RiskManager.spentOnGame(
				sameGameWithFirstPlayerProps[0].gameId
			);

			let positionRisk0 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				sameGameWithFirstPlayerProps[0].gameId,
				sameGameWithFirstPlayerProps[0].typeId,
				sameGameWithFirstPlayerProps[0].playerId,
				0
			);
			let positionRisk1 = await sportsAMMV2RiskManager.riskPerMarketTypeAndPosition(
				sameGameWithFirstPlayerProps[1].gameId,
				sameGameWithFirstPlayerProps[1].typeId,
				sameGameWithFirstPlayerProps[1].playerId,
				0
			);

			expect(spentOnGame.toString() * 1.0).to.equal(
				positionRisk0.toString() * 1.0 + positionRisk1.toString() * 1.0
			);
		});

		it('Should fail SGP due to SGP combo risk', async () => {
			await sportsAMMV2RiskManager.setSGPEnabledOnSportIds([SPORT_ID_NBA], true);

			let approvedQuote = ethers.parseEther('0.25');

			await sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
				_tradeData: sameGameWithFirstPlayerProps,
				_buyInAmount: ethers.parseEther('500'),
				_expectedQuote: approvedQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);

			await expect(
				mockChainlinkOracle.fulfillSGPTrade(requestId, true, approvedQuote)
			).to.be.revertedWith('SGP Risk per game exceeded');
		});

		it('Ensure same SGP hashes for different order on SGP', async () => {
			let sgpHashFirst = await sportsAMMV2RiskManager.getSGPHash(sameGameWithFirstPlayerProps);

			let sgpHashSecond = await sportsAMMV2RiskManager.getSGPHash(sameGameWithSecondPlayerProps);

			expect(sgpHashFirst).to.equal(sgpHashSecond);
		});

		it('Should revert if Merkle proof verification fails', async () => {
			await sportsAMMV2RiskManager.setSGPEnabledOnSportIds([SPORT_ID_NBA], true);
			let approvedQuote = ethers.parseEther('0.5');

			// Manipulate trade data to have an incorrect Merkle proof (simulate invalid proof)
			let invalidTradeData = [...sameGameWithFirstPlayerProps];
			invalidTradeData[0].merkleProof = [
				'0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
			]; // Invalid proof

			await expect(
				sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
					_tradeData: invalidTradeData,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: approvedQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				})
			).to.be.revertedWith('Proof is not valid"');
		});
	});
});
