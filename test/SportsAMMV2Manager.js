const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { upgrades } = require('hardhat');

describe('SportsAMMV2Manager', function () {
	// We define a fixture to reuse the same setup in every test.
	// We use loadFixture to run this setup once, snapshot that state,
	// and reset Hardhat Network to that snapshot in every test.
	async function deploySportsAMMV2ManagerFixture() {
		const needsTransformingCollateral = false;

		// Contracts are deployed using the first signer/account by default
		const [owner, otherAccount, thirdAccount, fourthAccount] = await ethers.getSigners();

		const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
		const sportsAMMV2Manager = await upgrades.deployProxy(SportsAMMV2Manager, [
			owner.address,
			needsTransformingCollateral,
		]);

		return {
			sportsAMMV2Manager,
			needsTransformingCollateral,
			owner,
			otherAccount,
			thirdAccount,
			fourthAccount,
		};
	}

	describe('Deployment', function () {
		it('Should set the right owner', async function () {
			const { sportsAMMV2Manager, owner } = await loadFixture(deploySportsAMMV2ManagerFixture);

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
			const { sportsAMMV2Manager, otherAccount } = await loadFixture(
				deploySportsAMMV2ManagerFixture
			);

			const newNeedsTransformingCollateral = true;

			expect(
				sportsAMMV2Manager.setNeedsTransformingCollateral(newNeedsTransformingCollateral, {
					from: otherAccount,
				})
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2Manager.setNeedsTransformingCollateral(newNeedsTransformingCollateral);
			expect(await sportsAMMV2Manager.needsTransformingCollateral()).to.equal(
				newNeedsTransformingCollateral
			);

			expect(sportsAMMV2Manager.setNeedsTransformingCollateral(newNeedsTransformingCollateral))
				.to.emit(sportsAMMV2Manager, 'NeedsTransformingCollateralUpdated')
				.withArgs(newNeedsTransformingCollateral);
		});

		it('Should set the new whitelisted addresses', async function () {
			const { sportsAMMV2Manager, otherAccount, thirdAccount, fourthAccount } = await loadFixture(
				deploySportsAMMV2ManagerFixture
			);

			let whitelistedAddresses = [];
			const isWhitelisted = true;

			expect(
				sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted, {
					from: otherAccount,
				})
			).to.be.revertedWith('Only the contract owner may perform this action');
			expect(
				sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted)
			).to.be.revertedWith('Whitelisted addresses cannot be empty');

			whitelistedAddresses = [thirdAccount, fourthAccount];

			await sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(otherAccount)).to.equal(false);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(thirdAccount)).to.equal(isWhitelisted);
			expect(await sportsAMMV2Manager.isWhitelistedAddress(fourthAccount)).to.equal(isWhitelisted);

			expect(sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted))
				.to.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.withArgs(thirdAccount, isWhitelisted);
			expect(sportsAMMV2Manager.setWhitelistedAddresses(whitelistedAddresses, isWhitelisted))
				.to.emit(sportsAMMV2Manager, 'AddedIntoWhitelist')
				.withArgs(fourthAccount, isWhitelisted);
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
