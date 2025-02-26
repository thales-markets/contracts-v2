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
		it('Should allow the owner to change ownership', async function () {
			const { sessionValidationModule, owner, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await sessionValidationModule.changeOwner(otherAccount.address);
			expect(await sessionValidationModule.owner()).to.equal(otherAccount.address);
		});

		it('Should prevent non-owner from changing ownership', async function () {
			const { sessionValidationModule, attacker } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await expect(
				sessionValidationModule.connect(attacker).changeOwner(attacker.address)
			).to.be.revertedWith('Not the owner');
		});
	});

	describe('Whitelist Management', function () {
		it('Should allow owner to update whitelist', async function () {
			const { sessionValidationModule, owner, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			const destinationContract = otherAccount.address;
			await sessionValidationModule.updateWhitelist(destinationContract, true);
			expect(await sessionValidationModule.whitelistedContracts(otherAccount.address)).to.be.true;
		});

		it('Should prevent non-owner from updating whitelist', async function () {
			const { sessionValidationModule, attacker, otherAccount } = await loadFixture(
				deploySessionValidationModuleFixture
			);
			await expect(
				sessionValidationModule.connect(attacker).updateWhitelist(otherAccount.address, true)
			).to.be.revertedWith('Not the owner');
		});
	});

	// describe('Session Validation', function () {
	// 	it('Should validate whitelisted contract interactions', async function () {
	// 		const { sessionValidationModule, owner, otherAccount } = await loadFixture(deploySessionValidationModuleFixture);
	// 		await sessionValidationModule.updateWhitelist(otherAccount.address, true);
	//
	// 		// Mocking user operation and signature
	// 		const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("test-operation"));
	// 		const signature = await owner.signMessage(ethers.getBytes(userOpHash));
	//
	// 		expect(await sessionValidationModule.validateSessionUserOp({
	// 			sender: owner.address,
	// 			nonce: 0,
	// 			initCode: "0x",
	// 			callData: ethers.solidityPacked(["address"], [otherAccount.address]),
	// 			callGasLimit: 0,
	// 			verificationGasLimit: 0,
	// 			preVerificationGas: 0,
	// 			maxFeePerGas: 0,
	// 			maxPriorityFeePerGas: 0,
	// 			paymasterAndData: "0x",
	// 			signature: signature
	// 		}, userOpHash, "0x", signature)).to.be.true;
	// 	});
	// });
});
