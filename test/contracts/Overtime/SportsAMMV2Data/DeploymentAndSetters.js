const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Data Deployment And Setters', () => {
	let sportsAMMV2Data, sportsAMMV2, sportsAMMV2RiskManager, owner, secondAccount, thirdAccount;

	beforeEach(async () => {
		({ sportsAMMV2Data, sportsAMMV2, sportsAMMV2RiskManager, owner } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2Data.owner()).to.equal(owner.address);
		});

		it('Should set the right Sports AMM', async () => {
			expect(await sportsAMMV2Data.sportsAMM()).to.equal(await sportsAMMV2.getAddress());
		});

		it('Should set the right risk manager', async () => {
			expect(await sportsAMMV2Data.riskManager()).to.equal(
				await sportsAMMV2RiskManager.getAddress()
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new Sports AMM', async () => {
			await expect(
				sportsAMMV2Data.connect(secondAccount).setSportsAMM(thirdAccount)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2Data.setSportsAMM(thirdAccount);
			expect(await sportsAMMV2Data.sportsAMM()).to.equal(thirdAccount.address);

			await expect(sportsAMMV2Data.setSportsAMM(thirdAccount))
				.to.emit(sportsAMMV2Data, 'SportAMMChanged')
				.withArgs(thirdAccount.address);
		});

		it('Should set the new risk manager', async () => {
			await expect(
				sportsAMMV2Data.connect(secondAccount).setRiskManager(thirdAccount)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2Data.setRiskManager(thirdAccount);
			expect(await sportsAMMV2Data.riskManager()).to.equal(thirdAccount.address);

			await expect(sportsAMMV2Data.setRiskManager(thirdAccount))
				.to.emit(sportsAMMV2Data, 'RiskManagerChanged')
				.withArgs(thirdAccount.address);
		});
	});
});
