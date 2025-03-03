const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');

// Helper function to deploy the contract and properly initialize it
async function deploySessionValidationModuleFixture() {
	const [owner, otherAccount, attacker] = await ethers.getSigners();

	const SessionValidationModule = await ethers.getContractFactory('SessionValidationModule');
	const sessionValidationModule = await SessionValidationModule.deploy();
	await sessionValidationModule.waitForDeployment();

	// Ensure the contract is properly initialized with an owner
	await sessionValidationModule.initialize(owner.address, []);

	return { sessionValidationModule, owner, otherAccount, attacker };
}

describe('SessionValidationModule', function () {
	describe('Deployment', function () {
		it('Should deploy and set the right owner', async function () {
			const { sessionValidationModule, owner } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			expect(await sessionValidationModule.owner()).to.equal(owner.address);
		});
	});

	describe('Ownership', function () {
		it('Should allow the owner to nominate a new owner', async function () {
			const { sessionValidationModule, owner, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await sessionValidationModule.nominateNewOwner(otherAccount.address);
			expect(await sessionValidationModule.nominatedOwner()).to.equal(otherAccount.address);
		});

		it('Should allow the nominated owner to accept ownership', async function () {
			const { sessionValidationModule, owner, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await sessionValidationModule.nominateNewOwner(otherAccount.address);
			await sessionValidationModule.connect(otherAccount).acceptOwnership();
			expect(await sessionValidationModule.owner()).to.equal(otherAccount.address);
		});

		it('Should prevent non-owner from nominating a new owner', async function () {
			const { sessionValidationModule, attacker } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await expect(
				sessionValidationModule.connect(attacker).nominateNewOwner(attacker.address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should prevent non-nominated address from accepting ownership', async function () {
			const { sessionValidationModule, owner, otherAccount, attacker } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await sessionValidationModule.nominateNewOwner(otherAccount.address);
			await expect(sessionValidationModule.connect(attacker).acceptOwnership()).to.be.revertedWith(
				'You must be nominated before you can accept ownership'
			);
		});
	});

	describe('Whitelist Management', function () {
		it('Should allow owner to update whitelist', async function () {
			const { sessionValidationModule, owner, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			const destinationContract = otherAccount.address;
			await sessionValidationModule.updateWhitelist(destinationContract, true);
			expect(await sessionValidationModule.whitelistedContracts(destinationContract)).to.be.true;
		});

		it('Should prevent non-owner from updating whitelist', async function () {
			const { sessionValidationModule, attacker, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await expect(
				sessionValidationModule.connect(attacker).updateWhitelist(otherAccount.address, true)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});
	});
});
