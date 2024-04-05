const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2ResultManager Deployment And Setters', () => {
	let sportsAMMV2ResultManager, sportsAMMV2Manager, owner, secondAccount, thirdAccount;

	beforeEach(async () => {
		({ sportsAMMV2ResultManager, sportsAMMV2Manager, owner } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2ResultManager.owner()).to.equal(owner.address);
		});

		it('Should set the right manager', async () => {
			expect(await sportsAMMV2ResultManager.manager()).to.equal(
				await sportsAMMV2Manager.getAddress()
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new manager', async () => {
			await expect(
				sportsAMMV2ResultManager.connect(secondAccount).setSportsManager(thirdAccount)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(sportsAMMV2ResultManager.setSportsManager(ZERO_ADDRESS)).to.be.revertedWith(
				'Invalid address'
			);

			await sportsAMMV2ResultManager.setSportsManager(thirdAccount);
			expect(await sportsAMMV2ResultManager.manager()).to.equal(thirdAccount.address);

			await expect(sportsAMMV2ResultManager.setSportsManager(thirdAccount))
				.to.emit(sportsAMMV2ResultManager, 'SetSportsManager')
				.withArgs(thirdAccount.address);
		});
	});
});
