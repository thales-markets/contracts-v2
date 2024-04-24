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
});
