const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Manager Deployment and Setters', () => {
	let sportsAMMV2Manager, owner, secondAccount, thirdAccount, fourthAccount;

	beforeEach(async () => {
		({ sportsAMMV2Manager, owner } = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount, fourthAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2Manager.owner()).to.equal(owner.address);
		});
	});

	describe('Setters', () => {
		it('Should set the new whitelisted addresses', async () => {
			let whitelistedAddresses = [];
			const isWhitelisted = true;

			await expect(
				sportsAMMV2Manager
					.connect(secondAccount)
					.setWhitelistedAddresses(whitelistedAddresses, 2, isWhitelisted)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, 2, isWhitelisted)
			).to.be.revertedWith('Whitelisted addresses cannot be empty');

			whitelistedAddresses = [thirdAccount, fourthAccount];

			await sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, 2, isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount, 2)).to.equal(false);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount, 2)).to.equal(
				isWhitelisted
			);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount, 2)).to.equal(
				isWhitelisted
			);

			await expect(
				sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, 2, !isWhitelisted)
			)
				.to.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.withArgs(thirdAccount.address, 2, !isWhitelisted)
				.to.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.withArgs(fourthAccount.address, 2, !isWhitelisted);
		});

		it('Should not change the whitelisted addresses', async () => {
			const isWhitelisted = false;
			let whitelistedAddresses = [thirdAccount, fourthAccount];

			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount, 2)).to.equal(
				isWhitelisted
			);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount, 2)).to.equal(
				isWhitelisted
			);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount, 2)).to.equal(
				isWhitelisted
			);

			await sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, 2, isWhitelisted);

			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount, 2)).to.equal(
				isWhitelisted
			);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount, 2)).to.equal(
				isWhitelisted
			);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount, 2)).to.equal(
				isWhitelisted
			);

			await expect(
				sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, 2, isWhitelisted)
			)
				.to.not.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.to.not.emit(sportsAMMV2Manager, 'AddedIntoWhitelist');
		});
	});
});
