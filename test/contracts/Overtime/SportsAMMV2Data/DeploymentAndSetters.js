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
		it('Should set the new Sports AMM and risk manager (single setter)', async () => {
			// non-owner
			await expect(
				sportsAMMV2Data
					.connect(secondAccount)
					.setAddresses(thirdAccount.address, thirdAccount.address)
			).to.be.revertedWith('Only the contract owner may perform this action');

			// owner updates state
			await sportsAMMV2Data.setAddresses(thirdAccount.address, thirdAccount.address);

			expect(await sportsAMMV2Data.sportsAMM()).to.equal(thirdAccount.address);
			expect(await sportsAMMV2Data.riskManager()).to.equal(thirdAccount.address);

			// emits merged event
			await expect(sportsAMMV2Data.setAddresses(thirdAccount.address, thirdAccount.address))
				.to.emit(sportsAMMV2Data, 'AddressesUpdated')
				.withArgs(thirdAccount.address, thirdAccount.address);
		});

		it('Should allow setting only one address by passing the current value for the other', async () => {
			const currentSportsAMM = await sportsAMMV2Data.sportsAMM();
			const currentRiskManager = await sportsAMMV2Data.riskManager();

			// change only sportsAMM
			await sportsAMMV2Data.setAddresses(thirdAccount.address, currentRiskManager);
			expect(await sportsAMMV2Data.sportsAMM()).to.equal(thirdAccount.address);
			expect(await sportsAMMV2Data.riskManager()).to.equal(currentRiskManager);

			// change only riskManager
			await sportsAMMV2Data.setAddresses(currentSportsAMM, thirdAccount.address);
			expect(await sportsAMMV2Data.sportsAMM()).to.equal(currentSportsAMM);
			expect(await sportsAMMV2Data.riskManager()).to.equal(thirdAccount.address);
		});
	});
});
