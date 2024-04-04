const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE, SPORT_ID_NBA } = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		liveTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		collateral;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			liveTradingProcessor,
			mockChainlinkOracle,
			sportsAMMV2RiskManager,
			collateral,
		} = await loadFixture(deploySportsAMMV2Fixture));
	});

	describe('Live Trade', () => {
		it('Setters', async () => {
			await liveTradingProcessor.setPaused(true);
			await liveTradingProcessor.setMaxAllowedExecutionDelay(30);

			const collateralAddress = await collateral.getAddress();
			const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';
			await liveTradingProcessor.setConfiguration(
				collateralAddress, //link
				collateralAddress, //_oracle
				collateralAddress, // _sportsAMM
				mockSpecId, // _specId
				0 // payment
			);
		});
	});
});
