const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { MerkleTree } = require('merkletreejs');
const { ZERO_ADDRESS } = require('../../constants/general');

describe('OverdropRewards', () => {
	let overdropRewards,
		mockToken,
		owner,
		user1,
		user2,
		user3,
		nonEligibleUser,
		merkleTree,
		merkleRoot,
		rewardAmount1,
		rewardAmount2,
		rewardAmount3,
		totalRewards;

	// Sample reward data for merkle tree
	const rewardData = [
		{ address: '', amount: ethers.parseEther('100') },
		{ address: '', amount: ethers.parseEther('200') },
		{ address: '', amount: ethers.parseEther('150') },
	];

	async function deployOverdropRewardsFixture() {
		
		[owner, user1, user2, user3, nonEligibleUser] = await ethers.getSigners();

		rewardData[0].address = user1.address;
		rewardData[1].address = user2.address;
		rewardData[2].address = user3.address;

		rewardAmount1 = rewardData[0].amount;
		rewardAmount2 = rewardData[1].amount;
		rewardAmount3 = rewardData[2].amount;

		const MockToken = await ethers.getContractFactory('ExoticUSD');
		mockToken = await MockToken.deploy();


		const additionalTokens = ethers.parseEther('10000');
		await mockToken.connect(owner).mintForUser(owner.address, { value: 0 });
		await mockToken.connect(owner).setDefaultAmount(additionalTokens);
		await mockToken.connect(owner).mintForUser(owner.address, { value: 0 });

		// Create merkle tree
		const leaves = rewardData.map(({ address, amount }) =>
			ethers.solidityPackedKeccak256(['address', 'uint256'], [address, amount])
		);
		merkleTree = new MerkleTree(leaves, ethers.keccak256, { sortPairs: true });
		merkleRoot = merkleTree.getHexRoot();
		totalRewards = ethers.parseEther('450'); // 100 + 200 + 150

		const OverdropRewards = await ethers.getContractFactory('OverdropRewards');
		overdropRewards = await upgrades.deployProxy(OverdropRewards, [
			owner.address,
			await mockToken.getAddress(),
			merkleRoot,
			totalRewards,
		]);

		await mockToken.connect(owner).transfer(await overdropRewards.getAddress(), totalRewards);

		return {
			overdropRewards,
			mockToken,
			owner,
			user1,
			user2,
			user3,
			nonEligibleUser,
			merkleTree,
			merkleRoot,
			rewardAmount1,
			rewardAmount2,
			rewardAmount3,
			totalRewards,
		};
	}

	function generateProof(userAddress, amount) {
		const leaf = ethers.solidityPackedKeccak256(['address', 'uint256'], [userAddress, amount]);
		return merkleTree.getHexProof(leaf);
	}

	beforeEach(async () => {
		({
			overdropRewards,
			mockToken,
			owner,
			user1,
			user2,
			user3,
			nonEligibleUser,
			merkleTree,
			merkleRoot,
			rewardAmount1,
			rewardAmount2,
			rewardAmount3,
			totalRewards,
		} = await loadFixture(deployOverdropRewardsFixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await overdropRewards.owner()).to.equal(owner.address);
		});

		it('Should set the right collateral token', async () => {
			expect(await overdropRewards.collateral()).to.equal(await mockToken.getAddress());
		});

		it('Should set the right merkle root', async () => {
			expect(await overdropRewards.merkleRoot()).to.equal(merkleRoot);
		});

		it('Should set the right total rewards', async () => {
			expect(await overdropRewards.totalRewards()).to.equal(totalRewards);
		});

		it('Should start with season 1', async () => {
			expect(await overdropRewards.currentSeason()).to.equal(1);
		});

		it('Should start with claims disabled', async () => {
			expect(await overdropRewards.claimsEnabled()).to.equal(false);
		});

		it('Should start with zero total claimed', async () => {
			expect(await overdropRewards.totalClaimed()).to.equal(0);
		});

		it('Should revert if initialized with zero address collateral', async () => {
			const OverdropRewards = await ethers.getContractFactory('OverdropRewards');
			await expect(
				upgrades.deployProxy(OverdropRewards, [
					owner.address,
					ZERO_ADDRESS,
					merkleRoot,
					totalRewards,
				])
			).to.be.revertedWith('Invalid collateral token');
		});

		it('Should revert if initialized with zero merkle root', async () => {
			const OverdropRewards = await ethers.getContractFactory('OverdropRewards');
			await expect(
				upgrades.deployProxy(OverdropRewards, [
					owner.address,
					await mockToken.getAddress(),
					ethers.ZeroHash,
					totalRewards,
				])
			).to.be.revertedWith('Invalid merkle root');
		});
	});

	describe('View Functions', () => {
		it('Should correctly return if user has claimed rewards', async () => {
			expect(await overdropRewards.hasClaimedRewards(user1.address)).to.equal(false);
		});

		it('Should correctly return if user has claimed rewards in specific season', async () => {
			expect(await overdropRewards.hasClaimedRewardsInSeason(user1.address, 1)).to.equal(false);
		});

		it('Should correctly return remaining rewards', async () => {
			expect(await overdropRewards.remainingRewards()).to.equal(totalRewards);
		});

		it('Should correctly verify valid merkle proof', async () => {
			const proof = generateProof(user1.address, rewardAmount1);
			expect(await overdropRewards.verifyProof(user1.address, rewardAmount1, proof)).to.equal(
				true
			);
		});

		it('Should correctly reject invalid merkle proof', async () => {
			const proof = generateProof(user1.address, rewardAmount1);
			expect(await overdropRewards.verifyProof(user2.address, rewardAmount1, proof)).to.equal(
				false
			);
		});

		it('Should correctly reject proof with wrong amount', async () => {
			const proof = generateProof(user1.address, rewardAmount1);
			expect(
				await overdropRewards.verifyProof(user1.address, ethers.parseEther('50'), proof)
			).to.equal(false);
		});
	});

	describe('Enable Claims', () => {
		it('Should allow owner to enable claims', async () => {
			await expect(overdropRewards.connect(owner).enableClaims(true))
				.to.emit(overdropRewards, 'ClaimsEnabled')
				.withArgs(true);

			expect(await overdropRewards.claimsEnabled()).to.equal(true);
		});

		it('Should allow owner to disable claims', async () => {
			await overdropRewards.connect(owner).enableClaims(true);
			await expect(overdropRewards.connect(owner).enableClaims(false))
				.to.emit(overdropRewards, 'ClaimsEnabled')
				.withArgs(false);

			expect(await overdropRewards.claimsEnabled()).to.equal(false);
		});

		it('Should revert if non-owner tries to enable claims', async () => {
			await expect(overdropRewards.connect(user1).enableClaims(true)).to.be.revertedWith(
				'Only the contract owner may perform this action'
			);
		});
	});

	describe('Claim Rewards', () => {
		beforeEach(async () => {
			await overdropRewards.connect(owner).enableClaims(true);
		});

		it('Should allow eligible user to claim rewards', async () => {
			const proof = generateProof(user1.address, rewardAmount1);
			const initialBalance = await mockToken.balanceOf(user1.address);

			await expect(overdropRewards.connect(user1).claimRewards(rewardAmount1, proof))
				.to.emit(overdropRewards, 'RewardsClaimed')
				.withArgs(user1.address, rewardAmount1, 1);

			expect(await mockToken.balanceOf(user1.address)).to.equal(initialBalance + rewardAmount1);
			expect(await overdropRewards.hasClaimedRewards(user1.address)).to.equal(true);
			expect(await overdropRewards.totalClaimed()).to.equal(rewardAmount1);
		});

		it('Should allow multiple users to claim their rewards', async () => {
			const proof1 = generateProof(user1.address, rewardAmount1);
			const proof2 = generateProof(user2.address, rewardAmount2);

			await overdropRewards.connect(user1).claimRewards(rewardAmount1, proof1);
			await overdropRewards.connect(user2).claimRewards(rewardAmount2, proof2);

			expect(await overdropRewards.hasClaimedRewards(user1.address)).to.equal(true);
			expect(await overdropRewards.hasClaimedRewards(user2.address)).to.equal(true);
			expect(await overdropRewards.totalClaimed()).to.equal(rewardAmount1 + rewardAmount2);
		});

		it('Should revert if claims are disabled', async () => {
			await overdropRewards.connect(owner).enableClaims(false);
			const proof = generateProof(user1.address, rewardAmount1);

			await expect(
				overdropRewards.connect(user1).claimRewards(rewardAmount1, proof)
			).to.be.revertedWith('Claims are disabled');
		});

		it('Should revert if user already claimed', async () => {
			const proof = generateProof(user1.address, rewardAmount1);

			await overdropRewards.connect(user1).claimRewards(rewardAmount1, proof);

			await expect(
				overdropRewards.connect(user1).claimRewards(rewardAmount1, proof)
			).to.be.revertedWith('Already claimed');
		});

		it('Should revert if amount is zero', async () => {
			const proof = generateProof(user1.address, rewardAmount1);

			await expect(overdropRewards.connect(user1).claimRewards(0, proof)).to.be.revertedWith(
				'Amount must be greater than 0'
			);
		});

		it('Should revert if merkle proof is invalid', async () => {
			const proof = generateProof(user1.address, rewardAmount1);

			await expect(
				overdropRewards.connect(user2).claimRewards(rewardAmount1, proof)
			).to.be.revertedWith('Invalid merkle proof');
		});

		it('Should revert if amount does not match proof', async () => {
			const proof = generateProof(user1.address, rewardAmount1);

			await expect(
				overdropRewards.connect(user1).claimRewards(ethers.parseEther('50'), proof)
			).to.be.revertedWith('Invalid merkle proof');
		});

		it('Should revert if user is not eligible', async () => {
			const fakeProof = generateProof(user1.address, rewardAmount1);

			await expect(
				overdropRewards.connect(nonEligibleUser).claimRewards(rewardAmount1, fakeProof)
			).to.be.revertedWith('Invalid merkle proof');
		});
	});

	describe('Deposit Rewards', () => {
		it('Should allow anyone to deposit additional rewards', async () => {
			const depositAmount = ethers.parseEther('100');
			await mockToken.connect(owner).transfer(user1.address, depositAmount);
			await mockToken.connect(user1).approve(await overdropRewards.getAddress(), depositAmount);

			const initialTotal = await overdropRewards.totalRewards();

			await expect(overdropRewards.connect(user1).depositRewards(depositAmount))
				.to.emit(overdropRewards, 'RewardsDeposited')
				.withArgs(depositAmount, user1.address);

			expect(await overdropRewards.totalRewards()).to.equal(initialTotal + depositAmount);
		});

		it('Should revert if deposit amount is zero', async () => {
			await expect(overdropRewards.connect(user1).depositRewards(0)).to.be.revertedWith(
				'Amount must be greater than 0'
			);
		});

		it('Should revert if user has insufficient token allowance', async () => {
			const depositAmount = ethers.parseEther('1000000');

			await expect(
				overdropRewards.connect(user1).depositRewards(depositAmount)
			).to.be.revertedWithCustomError(mockToken, 'ERC20InsufficientAllowance');
		});
	});

	describe('Update Merkle Root', () => {
		it('Should allow owner to update merkle root', async () => {
			const newRewardData = [
				{ address: user1.address, amount: ethers.parseEther('300') },
				{ address: user2.address, amount: ethers.parseEther('400') },
			];

			const newLeaves = newRewardData.map(({ address, amount }) =>
				ethers.solidityPackedKeccak256(['address', 'uint256'], [address, amount])
			);
			const newMerkleTree = new MerkleTree(newLeaves, ethers.keccak256, { sortPairs: true });
			const newMerkleRoot = newMerkleTree.getHexRoot();
			const newTotalRewards = ethers.parseEther('700');
			const newSeason = 2;

			await expect(
				overdropRewards.connect(owner).updateMerkleRoot(newMerkleRoot, newTotalRewards, false, newSeason)
			)
				.to.emit(overdropRewards, 'MerkleRootUpdated')
				.withArgs(merkleRoot, newMerkleRoot, newSeason, newTotalRewards);

			expect(await overdropRewards.merkleRoot()).to.equal(newMerkleRoot);
			expect(await overdropRewards.totalRewards()).to.equal(newTotalRewards);
			expect(await overdropRewards.currentSeason()).to.equal(newSeason);
		});

		it('Should reset claims when specified', async () => {
			await overdropRewards.connect(owner).enableClaims(true);
			const proof = generateProof(user1.address, rewardAmount1);
			await overdropRewards.connect(user1).claimRewards(rewardAmount1, proof);

			expect(await overdropRewards.totalClaimed()).to.equal(rewardAmount1);

			// Update merkle root with reset claims
			const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('new root'));
			const newSeason = 2;
			await overdropRewards
				.connect(owner)
				.updateMerkleRoot(newMerkleRoot, totalRewards, true, newSeason);

			expect(await overdropRewards.totalClaimed()).to.equal(0);
			expect(await overdropRewards.currentSeason()).to.equal(newSeason);
		});

		it('Should revert if non-owner tries to update merkle root', async () => {
			const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('new root'));
			const newSeason = 2;

			await expect(
				overdropRewards.connect(user1).updateMerkleRoot(newMerkleRoot, totalRewards, false, newSeason)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should revert if new merkle root is zero', async () => {
			const newSeason = 2;
			await expect(
				overdropRewards.connect(owner).updateMerkleRoot(ethers.ZeroHash, totalRewards, false, newSeason)
			).to.be.revertedWith('Invalid merkle root');
		});
	});

	describe('Set Collateral', () => {
		it('Should allow owner to set new collateral token', async () => {
			const NewToken = await ethers.getContractFactory('ExoticUSD');
			const newToken = await NewToken.deploy();

			await overdropRewards.connect(owner).setCollateral(await newToken.getAddress());

			expect(await overdropRewards.collateral()).to.equal(await newToken.getAddress());
		});

		it('Should revert if non-owner tries to set collateral', async () => {
			const NewToken = await ethers.getContractFactory('ExoticUSD');
			const newToken = await NewToken.deploy();

			await expect(
				overdropRewards.connect(user1).setCollateral(await newToken.getAddress())
			).to.be.revertedWith('Only the contract owner may perform this action');
		});
	});

	describe('Withdraw Collateral', () => {
		it('Should allow owner to withdraw specific amount', async () => {
			const withdrawAmount = ethers.parseEther('100');
			const initialBalance = await mockToken.balanceOf(user1.address);

			await expect(
				overdropRewards.connect(owner).withdrawCollateral(withdrawAmount, user1.address)
			)
				.to.emit(overdropRewards, 'CollateralWithdrawn')
				.withArgs(withdrawAmount, user1.address);

			expect(await mockToken.balanceOf(user1.address)).to.equal(initialBalance + withdrawAmount);
		});

		it('Should allow owner to withdraw all tokens (amount = 0)', async () => {
			const contractBalance = await mockToken.balanceOf(await overdropRewards.getAddress());
			const initialBalance = await mockToken.balanceOf(user1.address);

			await expect(overdropRewards.connect(owner).withdrawCollateral(0, user1.address))
				.to.emit(overdropRewards, 'CollateralWithdrawn')
				.withArgs(contractBalance, user1.address);

			expect(await mockToken.balanceOf(user1.address)).to.equal(
				initialBalance + contractBalance
			);
		});

		it('Should revert if non-owner tries to withdraw', async () => {
			await expect(
				overdropRewards.connect(user1).withdrawCollateral(ethers.parseEther('100'), user1.address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should revert if recipient is zero address', async () => {
			await expect(
				overdropRewards.connect(owner).withdrawCollateral(ethers.parseEther('100'), ZERO_ADDRESS)
			).to.be.revertedWith('Invalid recipient');
		});

		it('Should revert if withdraw amount exceeds balance', async () => {
			const contractBalance = await mockToken.balanceOf(await overdropRewards.getAddress());
			const excessiveAmount = contractBalance + ethers.parseEther('1');

			await expect(
				overdropRewards.connect(owner).withdrawCollateral(excessiveAmount, user1.address)
			).to.be.revertedWith('Insufficient balance');
		});
	});

	describe('Season Management', () => {
		it('Should track claims per season correctly', async () => {
			await overdropRewards.connect(owner).enableClaims(true);

			// User1 claims in season 1
			const proof1 = generateProof(user1.address, rewardAmount1);
			await overdropRewards.connect(user1).claimRewards(rewardAmount1, proof1);

			expect(await overdropRewards.hasClaimedRewardsInSeason(user1.address, 1)).to.equal(true);

			// Update to season 2
			const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('season 2'));
			const newSeason = 2;
			await overdropRewards
				.connect(owner)
				.updateMerkleRoot(newMerkleRoot, totalRewards, false, newSeason);

			expect(await overdropRewards.currentSeason()).to.equal(newSeason);
			expect(await overdropRewards.hasClaimedRewardsInSeason(user1.address, 1)).to.equal(true);
			expect(await overdropRewards.hasClaimedRewards(user1.address)).to.equal(false); // current season
		});
	});

	describe('Remaining Rewards Calculation', () => {
		beforeEach(async () => {
			await overdropRewards.connect(owner).enableClaims(true);
		});

		it('Should correctly calculate remaining rewards after claims', async () => {
			const proof1 = generateProof(user1.address, rewardAmount1);
			await overdropRewards.connect(user1).claimRewards(rewardAmount1, proof1);

			expect(await overdropRewards.remainingRewards()).to.equal(totalRewards - rewardAmount1);
		});

		it('Should return 0 if total claimed exceeds total rewards', async () => {
			// This is an edge case that shouldn't happen in normal operation
			// but we test for defensive programming
			const proof1 = generateProof(user1.address, rewardAmount1);
			const proof2 = generateProof(user2.address, rewardAmount2);
			const proof3 = generateProof(user3.address, rewardAmount3);

			await overdropRewards.connect(user1).claimRewards(rewardAmount1, proof1);
			await overdropRewards.connect(user2).claimRewards(rewardAmount2, proof2);
			await overdropRewards.connect(user3).claimRewards(rewardAmount3, proof3);

			// Manually reduce total rewards to test edge case
			const newSeason = 2;
			await overdropRewards.connect(owner).updateMerkleRoot(merkleRoot, ethers.parseEther('100'), false, newSeason);

			expect(await overdropRewards.remainingRewards()).to.equal(0);
		});
	});

	describe('Pausable Functionality', () => {
		it('Should allow owner to pause the contract', async () => {
			await overdropRewards.connect(owner).setPaused(true);
			expect(await overdropRewards.paused()).to.equal(true);
		});

		it('Should allow owner to unpause the contract', async () => {
			await overdropRewards.connect(owner).setPaused(true);
			await overdropRewards.connect(owner).setPaused(false);
			expect(await overdropRewards.paused()).to.equal(false);
		});

		it('Should revert if non-owner tries to pause', async () => {
			await expect(
				overdropRewards.connect(user1).setPaused(true)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should emit PauseChanged event', async () => {
			await expect(overdropRewards.connect(owner).setPaused(true))
				.to.emit(overdropRewards, 'PauseChanged')
				.withArgs(true);
		});

		it('Should prevent claiming when paused', async () => {
			await overdropRewards.connect(owner).enableClaims(true);
			await overdropRewards.connect(owner).setPaused(true);

			const proof = generateProof(user1.address, rewardAmount1);

			await expect(
				overdropRewards.connect(user1).claimRewards(rewardAmount1, proof)
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});

		it('Should prevent depositing when paused', async () => {
			await overdropRewards.connect(owner).setPaused(true);

			await expect(
				overdropRewards.connect(user1).depositRewards(ethers.parseEther('100'))
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});
	});
}); 