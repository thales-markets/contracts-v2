const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_INITAL_PARAMS } = require('./constants/overtime');

describe('SportsAMMV2', () => {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		collateral,
		referrals,
		stakingThales,
		safeBox,
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount;

	beforeEach(async () => {
		const sportsAMMV2Fixture = await loadFixture(deploySportsAMMV2Fixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		sportsAMMV2 = sportsAMMV2Fixture.sportsAMMV2;
		sportsAMMV2Manager = sportsAMMV2Fixture.sportsAMMV2Manager;
		sportsAMMV2RiskManager = sportsAMMV2Fixture.sportsAMMV2RiskManager;
		collateral = sportsAMMV2Fixture.collateral;
		referrals = sportsAMMV2Fixture.referrals;
		stakingThales = sportsAMMV2Fixture.stakingThales;
		safeBox = sportsAMMV2Fixture.safeBox;
		owner = sportsAMMV2Fixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
		fourthAccount = accountsFixture.fourthAccount;
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2.owner()).to.equal(owner.address);
		});

		it('Should set the right addresses', async () => {
			expect(await sportsAMMV2.defaultCollateral()).to.equal(await collateral.getAddress());
			expect(await sportsAMMV2.manager()).to.equal(await sportsAMMV2Manager.getAddress());
			expect(await sportsAMMV2.riskManager()).to.equal(await sportsAMMV2RiskManager.getAddress());
			expect(await sportsAMMV2.referrals()).to.equal(referrals.address);
			expect(await sportsAMMV2.stakingThales()).to.equal(stakingThales.address);
			expect(await sportsAMMV2.safeBox()).to.equal(safeBox.address);
		});

		it('Should set the right amounts', async () => {
			expect(await sportsAMMV2.safeBoxFee()).to.equal(SPORTS_AMM_INITAL_PARAMS.safeBoxFee);
			expect(await sportsAMMV2.minBuyInAmount()).to.equal(SPORTS_AMM_INITAL_PARAMS.minBuyInAmount);
			expect(await sportsAMMV2.maxTicketSize()).to.equal(SPORTS_AMM_INITAL_PARAMS.maxTicketSize);
			expect(await sportsAMMV2.maxSupportedAmount()).to.equal(
				SPORTS_AMM_INITAL_PARAMS.maxSupportedAmount
			);
			expect(await sportsAMMV2.maxSupportedOdds()).to.equal(
				SPORTS_AMM_INITAL_PARAMS.maxSupportedOdds
			);
		});

		it('Should set the right times', async () => {
			expect(await sportsAMMV2.minimalTimeLeftToMaturity()).to.equal(
				SPORTS_AMM_INITAL_PARAMS.minimalTimeLeftToMaturity
			);
			expect(await sportsAMMV2.expiryDuration()).to.equal(SPORTS_AMM_INITAL_PARAMS.expiryDuration);
		});
	});
});
