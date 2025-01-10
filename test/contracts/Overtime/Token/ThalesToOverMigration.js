const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('Migrate Thales to Over', () => {
	let overToken, thalesToOverMigration, firstLiquidityProvider, owner, secondAccount, firstTrader;

	beforeEach(async () => {
		({ overToken, thalesToken, thalesToOverMigration } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ owner, firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));
	});

	describe('Migrate Thales to Over', () => {
		beforeEach(async () => {
			await thalesToken.connect(owner).transfer(firstTrader.address, ethers.parseEther('1000'));
		});

		it('Migrate Thales to Over', async () => {
			// Set up initial balances
			const exchangeAmount = ethers.parseEther('100');
			await thalesToken.connect(firstTrader).approve(thalesToOverMigration.target, exchangeAmount);
			// Get initial balances
			const initialThalesBalance = await thalesToken.balanceOf(firstTrader.address);
			const initialOverBalance = await overToken.balanceOf(firstTrader.address);
			const balanceOnExchange = await overToken.balanceOf(thalesToOverMigration.target);

			await expect(
				thalesToOverMigration.connect(firstTrader).migrateThalesToOver(exchangeAmount)
			).to.be.revertedWith('Insufficient OVER token balance');

			await overToken.connect(owner).transfer(thalesToOverMigration.target, exchangeAmount);

			// Perform exchange
			await thalesToOverMigration.connect(firstTrader).migrateThalesToOver(exchangeAmount);

			// Get final balances
			const finalThalesBalance = await thalesToken.balanceOf(firstTrader.address);
			const finalOverBalance = await overToken.balanceOf(firstTrader.address);

			// Verify exchange occurred correctly
			expect(finalThalesBalance).to.equal(initialThalesBalance - exchangeAmount);
			expect(finalOverBalance).to.be.gt(initialOverBalance);
		});

		it('Should revert when exchange amount is zero', async () => {
			await expect(
				thalesToOverMigration.connect(firstTrader).migrateThalesToOver(0)
			).to.be.revertedWithCustomError(thalesToOverMigration, 'AmountIsZero()');
		});

		it('Should revert when user has insufficient balance', async () => {
			const largeAmount = ethers.parseEther('1000000');
			await expect(
				thalesToOverMigration.connect(firstTrader).migrateThalesToOver(largeAmount)
			).to.be.revertedWith('Insufficient OVER token balance');
		});
		it('Should revert when user has insufficient balance', async () => {
			const largeAmount = ethers.parseEther('1000000');
			await thalesToken.connect(firstTrader).approve(thalesToOverMigration.target, largeAmount);
			await expect(
				thalesToOverMigration.connect(firstTrader).migrateThalesToOver(largeAmount)
			).to.be.revertedWith('Insufficient OVER token balance');
		});

		it('Should revert when contract is paused', async () => {
			const exchangeAmount = ethers.parseEther('100');
			await thalesToOverMigration.setPaused(true);

			await expect(
				thalesToOverMigration.connect(firstTrader).migrateThalesToOver(exchangeAmount)
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});
	});

	describe('Admin functions', () => {
		it('Should allow owner to withdraw collateral', async () => {
			const amount = ethers.parseEther('100');
			// Transfer some tokens to the contract first
			await overToken.connect(owner).transfer(thalesToOverMigration.target, amount);

			const initialBalance = await overToken.balanceOf(owner.address);

			await thalesToOverMigration.connect(owner).withdrawCollateral(overToken.target, amount);

			const finalBalance = await overToken.balanceOf(owner.address);
			expect(finalBalance).to.equal(initialBalance + amount);
		});

		it('Should revert withdrawCollateral if called by non-owner', async () => {
			const amount = ethers.parseEther('100');
			await expect(
				thalesToOverMigration.connect(firstTrader).withdrawCollateral(overToken.target, amount)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should allow owner to set new Thales address', async () => {
			const newAddress = secondAccount.address;
			await thalesToOverMigration.connect(owner).setThalesToken(newAddress);

			expect(await thalesToOverMigration.thalesToken()).to.equal(newAddress);
		});

		it('Should revert setThales if called by non-owner', async () => {
			const newAddress = secondAccount.address;
			await expect(
				thalesToOverMigration.connect(firstTrader).setThalesToken(newAddress)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should allow owner to set new Over address', async () => {
			const newAddress = secondAccount.address;
			await thalesToOverMigration.connect(owner).setOverToken(newAddress);

			expect(await thalesToOverMigration.overToken()).to.equal(newAddress);
		});

		it('Should revert setOver if called by non-owner', async () => {
			const newAddress = secondAccount.address;
			await expect(
				thalesToOverMigration.connect(firstTrader).setOverToken(newAddress)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should emit events when admin functions are called', async () => {
			const amount = ethers.parseEther('100');
			const newAddress = secondAccount.address;

			// Test SetThales event
			await expect(thalesToOverMigration.connect(owner).setThalesToken(newAddress))
				.to.emit(thalesToOverMigration, 'SetThalesToken')
				.withArgs(newAddress);

			// Test SetOver event
			await expect(thalesToOverMigration.connect(owner).setOverToken(newAddress))
				.to.emit(thalesToOverMigration, 'SetOverToken')
				.withArgs(newAddress);

			// Transfer some tokens to test WithdrawnCollateral event
			await overToken.connect(owner).transfer(thalesToOverMigration.target, amount);
			await expect(
				thalesToOverMigration.connect(owner).withdrawCollateral(overToken.target, amount)
			)
				.to.emit(thalesToOverMigration, 'WithdrawnCollateral')
				.withArgs(overToken.target, amount);
		});
	});

	describe('Basic token information', () => {
		it('Should return correct token name', async () => {
			expect(await overToken.name()).to.equal('Overtime DAO Token');
		});

		it('Should return correct token symbol', async () => {
			expect(await overToken.symbol()).to.equal('OVER');
		});

		it('Should return correct number of decimals', async () => {
			expect(await overToken.decimals()).to.equal(18);
		});

		it('Should have minted initial supply to treasury', async () => {
			const expectedSupply = ethers.parseEther('69420000');
			expect(await overToken.totalSupply()).to.equal(expectedSupply);
			expect(await overToken.balanceOf(owner.address)).to.equal(expectedSupply);
		});
	});
});
