const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_LP_INITAL_PARAMS } = require('./constants/overtimeContractParams');

describe('SportsAMMV2LiquidityPool', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolRoundMastercopy,
		defaultLiquidityProvider,
		collateral,
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
		sportsAMMV2LiquidityPool = sportsAMMV2Fixture.sportsAMMV2LiquidityPool;
		sportsAMMV2LiquidityPoolRoundMastercopy =
			sportsAMMV2Fixture.sportsAMMV2LiquidityPoolRoundMastercopy;
		defaultLiquidityProvider = sportsAMMV2Fixture.defaultLiquidityProvider;
		collateral = sportsAMMV2Fixture.collateral;
		stakingThales = sportsAMMV2Fixture.stakingThales;
		safeBox = sportsAMMV2Fixture.safeBox;
		owner = sportsAMMV2Fixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
		fourthAccount = accountsFixture.fourthAccount;
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2LiquidityPool.owner()).to.equal(owner.address);
		});

		it('Should set the right addresses', async () => {
			expect(await sportsAMMV2LiquidityPool.collateral()).to.equal(await collateral.getAddress());
			expect(await sportsAMMV2LiquidityPool.stakingThales()).to.equal(stakingThales.address);
			expect(await sportsAMMV2LiquidityPool.safeBox()).to.equal(safeBox.address);
			expect(await sportsAMMV2LiquidityPool.sportsAMM()).to.equal(await sportsAMMV2.getAddress());
		});

		it('Should set the right amounts', async () => {
			expect(await sportsAMMV2LiquidityPool.maxAllowedDeposit()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedDeposit
			);
			expect(await sportsAMMV2LiquidityPool.maxAllowedDepositForUser()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedDepositForUser
			);
			expect(await sportsAMMV2LiquidityPool.minDepositAmount()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.minDepositAmount
			);
			expect(await sportsAMMV2LiquidityPool.maxAllowedUsers()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedUsers
			);
			expect(await sportsAMMV2LiquidityPool.utilizationRate()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.utilizationRate
			);
			expect(await sportsAMMV2LiquidityPool.safeBoxImpact()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.safeBoxImpact
			);
		});

		it('Should set the right times', async () => {
			expect(await sportsAMMV2LiquidityPool.roundLength()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.roundLength
			);
		});

		it('Should set the right round pool mastercopy', async () => {
			expect(await sportsAMMV2LiquidityPool.poolRoundMastercopy()).to.equal(
				await sportsAMMV2LiquidityPoolRoundMastercopy.getAddress()
			);
		});
		it('Should set the right default liquidity provider', async () => {
			expect(await sportsAMMV2LiquidityPool.defaultLiquidityProvider()).to.equal(
				await defaultLiquidityProvider.getAddress()
			);
		});
	});
});
