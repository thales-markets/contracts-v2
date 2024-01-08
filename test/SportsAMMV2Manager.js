const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2ManagerFixture,
	deployAccountsFixture,
} = require('./utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Manager', () => {
	let sportsAMMV2Manager,
		needsTransformingCollateral,
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount;

	beforeEach(async () => {
		const sportsAMMV2ManagerFixture = await loadFixture(deploySportsAMMV2ManagerFixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		sportsAMMV2Manager = sportsAMMV2ManagerFixture.sportsAMMV2Manager;
		needsTransformingCollateral = sportsAMMV2ManagerFixture.needsTransformingCollateral;
		owner = accountsFixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
		fourthAccount = accountsFixture.fourthAccount;
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2Manager.owner()).to.equal(owner.address);
		});

		it('Should set the right needsTransformingCollateral', async () => {
			expect(await sportsAMMV2Manager.needsTransformingCollateral()).to.equal(
				needsTransformingCollateral
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new needsTransformingCollateral', async () => {
			const newNeedsTransformingCollateral = true;

			await expect(
				sportsAMMV2Manager
					.connect(secondAccount)
					.setNeedsTransformingCollateral(newNeedsTransformingCollateral)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2Manager.setNeedsTransformingCollateral(newNeedsTransformingCollateral);
			expect(await sportsAMMV2Manager.needsTransformingCollateral()).to.equal(
				newNeedsTransformingCollateral
			);

			await expect(
				sportsAMMV2Manager.setNeedsTransformingCollateral(!newNeedsTransformingCollateral)
			)
				.to.emit(sportsAMMV2Manager, 'NeedsTransformingCollateralUpdated')
				.withArgs(!newNeedsTransformingCollateral);
		});

		it('Should not change the needsTransformingCollateral', async () => {
			const newNeedsTransformingCollateral = false;

			expect(await sportsAMMV2Manager.needsTransformingCollateral()).to.equal(
				newNeedsTransformingCollateral
			);
			await sportsAMMV2Manager.setNeedsTransformingCollateral(newNeedsTransformingCollateral);
			expect(await sportsAMMV2Manager.needsTransformingCollateral()).to.equal(
				newNeedsTransformingCollateral
			);

			await expect(
				sportsAMMV2Manager.setNeedsTransformingCollateral(newNeedsTransformingCollateral)
			).to.not.emit(sportsAMMV2Manager, 'NeedsTransformingCollateralUpdated');
		});

		it('Should set the new whitelisted addresses', async () => {
			let whitelistedAddresses = [];
			const isWhitelisted = true;

			await expect(
				sportsAMMV2Manager
					.connect(secondAccount)
					.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted)
			).to.be.revertedWith('Whitelisted addresses cannot be empty');

			whitelistedAddresses = [thirdAccount, fourthAccount];

			await sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount)).to.equal(false);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount)).to.equal(isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount)).to.equal(isWhitelisted);

			await expect(sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, !isWhitelisted))
				.to.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.withArgs(thirdAccount.address, !isWhitelisted)
				.to.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.withArgs(fourthAccount.address, !isWhitelisted);
		});

		it('Should not change the whitelisted addresses', async () => {
			const isWhitelisted = false;
			let whitelistedAddresses = [thirdAccount, fourthAccount];

			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount)).to.equal(isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount)).to.equal(isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount)).to.equal(isWhitelisted);

			await sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted);

			expect(await sportsAMMV2Manager.isWhitelistedAddress(secondAccount)).to.equal(isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount)).to.equal(isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount)).to.equal(isWhitelisted);

			await expect(sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted))
				.to.not.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.to.not.emit(sportsAMMV2Manager, 'AddedIntoWhitelist');
		});
	});

	describe('Transform collateral methods', () => {
		it('Transform collateral disabled', async () => {
			const { sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2ManagerFixture);

			const INITIAL_VALUE = 1_000_000_000_000;

			let transformedValue = await sportsAMMV2Manager.transformCollateral(INITIAL_VALUE);
			expect(transformedValue).to.equal(INITIAL_VALUE);

			transformedValue = await sportsAMMV2Manager.reverseTransformCollateral(INITIAL_VALUE);
			expect(transformedValue).to.equal(INITIAL_VALUE);
		});

		it('Transform collateral enabled', async () => {
			const { sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2ManagerFixture);

			await sportsAMMV2Manager.setNeedsTransformingCollateral(true);

			const INITIAL_VALUE = 1_000_000_000_000;

			let transformedValue = await sportsAMMV2Manager.transformCollateral(INITIAL_VALUE);
			expect(transformedValue).to.equal(1);

			transformedValue = await sportsAMMV2Manager.reverseTransformCollateral(1);
			expect(transformedValue).to.equal(INITIAL_VALUE);
		});
	});
});
