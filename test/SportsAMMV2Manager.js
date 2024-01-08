const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades } = require('hardhat');
const {
	deploySportsAMMV2ManagerFixture,
	deployAccountsFixture,
} = require('./utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Manager', function () {
	describe('Deployment', function () {
		it('Should set the right owner', async function () {
			const { sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2ManagerFixture);
			const { owner } = await loadFixture(deployAccountsFixture);

			expect(await sportsAMMV2Manager.owner()).to.equal(owner.address);
		});

		it('Should set the right needsTransformingCollateral', async function () {
			const { sportsAMMV2Manager, needsTransformingCollateral } = await loadFixture(
				deploySportsAMMV2ManagerFixture
			);

			expect(await sportsAMMV2Manager.needsTransformingCollateral()).to.equal(
				needsTransformingCollateral
			);
		});
	});

	describe('Setters', function () {
		it('Should set the new needsTransformingCollateral', async function () {
			const { sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2ManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

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

		it('Should set the new whitelisted addresses', async function () {
			const { sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2ManagerFixture);
			const { secondAccount, thirdAccount, fourthAccount } =
				await loadFixture(deployAccountsFixture);

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
	});

	describe('Transform collateral methods', function () {
		it('Transform collateral disabled', async function () {
			const { sportsAMMV2Manager } = await loadFixture(deploySportsAMMV2ManagerFixture);

			const INITIAL_VALUE = 1_000_000_000_000;

			let transformedValue = await sportsAMMV2Manager.transformCollateral(INITIAL_VALUE);
			expect(transformedValue).to.equal(INITIAL_VALUE);

			transformedValue = await sportsAMMV2Manager.reverseTransformCollateral(INITIAL_VALUE);
			expect(transformedValue).to.equal(INITIAL_VALUE);
		});

		it('Transform collateral enabled', async function () {
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
