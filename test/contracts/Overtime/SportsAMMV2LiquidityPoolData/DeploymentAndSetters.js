const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2LiquidityPoolData Deployment And Setters', () => {
	let sportsAMMV2Data, owner;

	beforeEach(async () => {
		({ sportsAMMV2Data, owner } = await loadFixture(deploySportsAMMV2Fixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2Data.owner()).to.equal(owner.address);
		});
	});
});
