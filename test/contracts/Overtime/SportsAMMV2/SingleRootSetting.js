const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_INITAL_PARAMS } = require('../../../constants/overtimeContractParams');
const { MAX_NUMBER, ZERO_ADDRESS } = require('../../../constants/general');
const { GAME_ID_1 } = require('../../../constants/overtime');

describe('SportsAMMV2 Deployment and Setters', () => {
	let sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		sportsAMMV2ResultManager,
		sportsAMMV2,
		ticketMastercopy,
		sportsAMMV2LiquidityPool,
		collateral,
		referrals,
		stakingThales,
		safeBox,
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		collateralAddress;

	beforeEach(async () => {
		({
			sportsAMMV2Manager,
			sportsAMMV2RiskManager,
			sportsAMMV2ResultManager,
			sportsAMMV2,
			ticketMastercopy,
			sportsAMMV2LiquidityPool,
			collateral,
			referrals,
			stakingThales,
			safeBox,
			owner,
			collateralAddress,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount, fourthAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Setters', () => {
		it('Should set the new root per game', async () => {
			const newRoot = '0x0ed8693864a15cd5d424428f9fa9454b8f1a8cd22c82016c214204edc9251978';

			await sportsAMMV2.setRootForGame(GAME_ID_1, newRoot);
			expect(await sportsAMMV2.rootPerGame(GAME_ID_1)).to.equal(newRoot);
		});
	});
});
