const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('SessionValidationModule', () => {
	let sessionValidationModule;
	let owner, user, sessionKey;
	let whitelistedContract1, whitelistedContract2;

	async function deploySessionValidationModuleFixture() {
		const [owner, user, sessionKey, whitelistedContract1, whitelistedContract2] =
			await ethers.getSigners();

		const SessionValidationModule = await ethers.getContractFactory('SessionValidationModule');
		const sessionValidationModule = await SessionValidationModule.deploy();

		// Initialize the contract with the owner and whitelisted contracts
		await sessionValidationModule.initialize(owner.address, [
			whitelistedContract1.address,
			whitelistedContract2.address,
		]);

		return {
			sessionValidationModule,
			owner,
			user,
			sessionKey,
			whitelistedContract1,
			whitelistedContract2,
		};
	}

	beforeEach(async () => {
		({
			sessionValidationModule,
			owner,
			user,
			sessionKey,
			whitelistedContract1,
			whitelistedContract2,
		} = await loadFixture(deploySessionValidationModuleFixture));
	});

	describe('validateSessionUserOp', () => {
		it('Should validate a user operation with a valid session key and whitelisted contract', async () => {
			// Function selector (example: assume it's for a function like `transfer(address)`)
			const functionSelector = ethers.id('transfer(address)').slice(0, 10); // First 4 bytes (8 hex chars + '0x')

			// Encode the callData with the function selector and the destination contract address
			const callData = ethers.concat([
				functionSelector, // 4-byte function selector
				ethers.zeroPadValue(whitelistedContract1.address, 32), // 32-byte padded destination contract address
			]);

			// Create a mock UserOperation
			const userOp = {
				sender: user.address,
				nonce: 0,
				initCode: '0x',
				callData: callData, // Use the correctly formatted callData
				callGasLimit: 1000000,
				verificationGasLimit: 1000000,
				preVerificationGas: 1000000,
				maxFeePerGas: ethers.parseUnits('10', 'gwei'),
				maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
				paymasterAndData: '0x', // No paymaster
				signature: '0x',
			};

			// Hash the UserOperation
			const userOpHash = ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(
					[
						'address',
						'uint256',
						'bytes',
						'bytes',
						'uint256',
						'uint256',
						'uint256',
						'uint256',
						'uint256',
						'bytes',
						'bytes',
					],
					[
						userOp.sender,
						userOp.nonce,
						userOp.initCode,
						userOp.callData,
						userOp.callGasLimit,
						userOp.verificationGasLimit,
						userOp.preVerificationGas,
						userOp.maxFeePerGas,
						userOp.maxPriorityFeePerGas,
						userOp.paymasterAndData,
						userOp.signature,
					]
				)
			);

			// Sign the userOpHash with the session key
			const sessionKeySignature = await sessionKey.signMessage(ethers.getBytes(userOpHash));

			// Encode sessionKeyData as raw bytes (without ABI encoding)
			const sessionKeyData = ethers.getBytes(sessionKey.address);

			// Call the function as a view function (no transaction)
			const isValid = await sessionValidationModule.validateSessionUserOp.staticCall(
				userOp,
				userOpHash,
				sessionKeyData,
				sessionKeySignature
			);

			// Verify the function returns true
			expect(isValid).to.be.true;
		});

		it('Should revert if the destination contract is not whitelisted', async () => {
			const nonWhitelistedContract = ethers.Wallet.createRandom().address;

			// Create a mock UserOperation with a non-whitelisted contract
			const userOp = {
				sender: user.address,
				nonce: 0,
				initCode: '0x',
				callData: ethers.AbiCoder.defaultAbiCoder().encode(
					['address', 'address'],
					[nonWhitelistedContract, whitelistedContract2.address]
				),
				callGasLimit: 1000000,
				verificationGasLimit: 1000000,
				preVerificationGas: 1000000,
				maxFeePerGas: ethers.parseUnits('10', 'gwei'),
				maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
				paymasterAndData: '0x',
				signature: '0x',
			};

			const userOpHash = ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(
					[
						'address',
						'uint256',
						'bytes',
						'bytes',
						'uint256',
						'uint256',
						'uint256',
						'uint256',
						'uint256',
						'bytes',
						'bytes',
					],
					[
						userOp.sender,
						userOp.nonce,
						userOp.initCode,
						userOp.callData,
						userOp.callGasLimit,
						userOp.verificationGasLimit,
						userOp.preVerificationGas,
						userOp.maxFeePerGas,
						userOp.maxPriorityFeePerGas,
						userOp.paymasterAndData,
						userOp.signature,
					]
				)
			);

			const sessionKeySignature = await sessionKey.signMessage(ethers.getBytes(userOpHash));
			const sessionKeyData = ethers.AbiCoder.defaultAbiCoder().encode(
				['address'],
				[sessionKey.address]
			);

			await expect(
				sessionValidationModule.validateSessionUserOp(
					userOp,
					userOpHash,
					sessionKeyData,
					sessionKeySignature
				)
			).to.be.revertedWith('DestContractNotWhitelisted');
		});

		it('Should revert if the session key signature is invalid', async () => {
			const userOp = {
				sender: user.address,
				nonce: 0,
				initCode: '0x',
				callData: ethers.AbiCoder.defaultAbiCoder().encode(
					['address', 'address'],
					[whitelistedContract1.address, whitelistedContract2.address]
				),
				callGasLimit: 1000000,
				verificationGasLimit: 1000000,
				preVerificationGas: 1000000,
				maxFeePerGas: ethers.parseUnits('10', 'gwei'),
				maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
				paymasterAndData: '0x',
				signature: '0x',
			};

			const userOpHash = ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(
					[
						'address',
						'uint256',
						'bytes',
						'bytes',
						'uint256',
						'uint256',
						'uint256',
						'uint256',
						'uint256',
						'bytes',
						'bytes',
					],
					[
						userOp.sender,
						userOp.nonce,
						userOp.initCode,
						userOp.callData,
						userOp.callGasLimit,
						userOp.verificationGasLimit,
						userOp.preVerificationGas,
						userOp.maxFeePerGas,
						userOp.maxPriorityFeePerGas,
						userOp.paymasterAndData,
						userOp.signature,
					]
				)
			);

			// Use an invalid signature (e.g., signed by a different key)
			const invalidSignature = await user.signMessage(ethers.getBytes(userOpHash));
			const sessionKeyData = ethers.AbiCoder.defaultAbiCoder().encode(
				['address'],
				[sessionKey.address]
			);

			await expect(
				sessionValidationModule.validateSessionUserOp(
					userOp,
					userOpHash,
					sessionKeyData,
					invalidSignature
				)
			).to.be.reverted; // Reverts due to invalid signature
		});
	});
});
