const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Live Deployment and Setters', () => {
	let sgpTradingProcessor, collateral;

	beforeEach(async () => {
		({ sgpTradingProcessor, collateral } = await loadFixture(deploySportsAMMV2Fixture));
	});

	describe('SGP setup', () => {
		it('Setters', async () => {
			await sgpTradingProcessor.setPaused(true);
			await sgpTradingProcessor.setMaxAllowedExecutionDelay(30);

			const collateralAddress = await collateral.getAddress();
			const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';
			await sgpTradingProcessor.setConfiguration(
				collateralAddress, //link
				collateralAddress, //_oracle
				collateralAddress, // _sportsAMM
				mockSpecId, // _specId
				0 // payment
			);
		});
	});
});
