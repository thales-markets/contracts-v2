const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Live Deployment and Setters', () => {
	let liveTradingProcessor, collateral;

	beforeEach(async () => {
		({ liveTradingProcessor, collateral } = await loadFixture(deploySportsAMMV2Fixture));
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
