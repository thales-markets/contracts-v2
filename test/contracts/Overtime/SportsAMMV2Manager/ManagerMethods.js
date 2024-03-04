const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployTokenFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Manager Methods', () => {
	let sportsAMMV2Manager, collateral, collateralSixDecimals;

	beforeEach(async () => {
		({ sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2Fixture));
		({ collateral, collateralSixDecimals } = await loadFixture(deployTokenFixture));
	});

	describe('Transform collateral methods', () => {
		it('Transform collateral disabled', async () => {
			const INITIAL_VALUE = 1_000_000_000_000;

			let transformedValue = await sportsAMMV2Manager.transformCollateral(
				INITIAL_VALUE,
				collateral
			);
			expect(transformedValue).to.equal(INITIAL_VALUE);

			transformedValue = await sportsAMMV2Manager.reverseTransformCollateral(
				INITIAL_VALUE,
				collateral
			);
			expect(transformedValue).to.equal(INITIAL_VALUE);
		});

		it('Transform collateral enabled', async () => {
			await sportsAMMV2Manager.setNeedsTransformingCollateral(true);

			const INITIAL_VALUE = 1_000_000_000_000;

			let transformedValue = await sportsAMMV2Manager.transformCollateral(
				INITIAL_VALUE,
				collateralSixDecimals
			);
			expect(transformedValue).to.equal(1);

			transformedValue = await sportsAMMV2Manager.reverseTransformCollateral(
				1,
				collateralSixDecimals
			);
			expect(transformedValue).to.equal(INITIAL_VALUE);
		});
	});
});
