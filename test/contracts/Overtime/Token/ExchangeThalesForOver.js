const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('Exchange Thales for Over', () => {
	let overToken, exchangeThalesForOver, firstLiquidityProvider, owner, secondAccount, firstTrader;

	beforeEach(async () => {
		({ overToken, thalesToken, exchangeThalesForOver } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ owner, firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));
	});

	describe('Exchange Thales for Over', () => {
		beforeEach(async () => {
			await thalesToken.connect(owner).transfer(firstTrader.address, ethers.parseEther('1000'));
		});

		it('Exchange Thales for Over', async () => {
			// Set up initial balances
			const exchangeAmount = ethers.parseEther('100');
			await thalesToken.connect(firstTrader).approve(exchangeThalesForOver.target, exchangeAmount);
			// Get initial balances
			const initialThalesBalance = await thalesToken.balanceOf(firstTrader.address);
			const initialOverBalance = await overToken.balanceOf(firstTrader.address);
			const balanceOnExchange = await overToken.balanceOf(exchangeThalesForOver.target);

			await expect(
				exchangeThalesForOver.connect(firstTrader).migrateThalesToOver(exchangeAmount)
			).to.be.revertedWithCustomError(
				overToken,
				'ERC20InsufficientBalance(address,uint256,uint256)'
			);

			await overToken.connect(owner).transfer(exchangeThalesForOver.target, exchangeAmount);

			// Perform exchange
			await exchangeThalesForOver.connect(firstTrader).migrateThalesToOver(exchangeAmount);

			// Get final balances
			const finalThalesBalance = await thalesToken.balanceOf(firstTrader.address);
			const finalOverBalance = await overToken.balanceOf(firstTrader.address);

			// Verify exchange occurred correctly
			expect(finalThalesBalance).to.equal(initialThalesBalance - exchangeAmount);
			expect(finalOverBalance).to.be.gt(initialOverBalance);
		});

		it('Should revert when exchange amount is zero', async () => {
			await expect(
				exchangeThalesForOver.connect(firstTrader).migrateThalesToOver(0)
			).to.be.revertedWithCustomError(exchangeThalesForOver, 'AmountIsZero()');
		});

		it('Should revert when user has insufficient balance', async () => {
			const largeAmount = ethers.parseEther('1000000');
			await expect(
				exchangeThalesForOver.connect(firstTrader).migrateThalesToOver(largeAmount)
			).to.be.revertedWithCustomError(thalesToken, 'ERC20InsufficientAllowance');
		});
		it('Should revert when user has insufficient balance', async () => {
			const largeAmount = ethers.parseEther('1000000');
			await thalesToken.connect(firstTrader).approve(exchangeThalesForOver.target, largeAmount);
			await expect(
				exchangeThalesForOver.connect(firstTrader).migrateThalesToOver(largeAmount)
			).to.be.revertedWithCustomError(
				thalesToken,
				'ERC20InsufficientBalance(address,uint256,uint256)'
			);
		});

		it('Should revert when contract is paused', async () => {
			const exchangeAmount = ethers.parseEther('100');
			await exchangeThalesForOver.setPaused(true);

			await expect(
				exchangeThalesForOver.connect(firstTrader).migrateThalesToOver(exchangeAmount)
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});
	});

	describe('Admin functions', () => {
		it('Should allow owner to withdraw collateral', async () => {
			const amount = ethers.parseEther('100');
			// Transfer some tokens to the contract first
			await overToken.connect(owner).transfer(exchangeThalesForOver.target, amount);

			const initialBalance = await overToken.balanceOf(owner.address);

			await exchangeThalesForOver.connect(owner).withdrawCollateral(overToken.target, amount);

			const finalBalance = await overToken.balanceOf(owner.address);
			expect(finalBalance).to.equal(initialBalance + amount);
		});

		it('Should revert withdrawCollateral if called by non-owner', async () => {
			const amount = ethers.parseEther('100');
			await expect(
				exchangeThalesForOver.connect(firstTrader).withdrawCollateral(overToken.target, amount)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should allow owner to set new Thales address', async () => {
			const newAddress = secondAccount.address;
			await exchangeThalesForOver.connect(owner).setThales(newAddress);

			expect(await exchangeThalesForOver.thalesToken()).to.equal(newAddress);
		});

		it('Should revert setThales if called by non-owner', async () => {
			const newAddress = secondAccount.address;
			await expect(
				exchangeThalesForOver.connect(firstTrader).setThales(newAddress)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should allow owner to set new Over address', async () => {
			const newAddress = secondAccount.address;
			await exchangeThalesForOver.connect(owner).setOver(newAddress);

			expect(await exchangeThalesForOver.overToken()).to.equal(newAddress);
		});

		it('Should revert setOver if called by non-owner', async () => {
			const newAddress = secondAccount.address;
			await expect(
				exchangeThalesForOver.connect(firstTrader).setOver(newAddress)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Should emit events when admin functions are called', async () => {
			const amount = ethers.parseEther('100');
			const newAddress = secondAccount.address;

			// Test SetThales event
			await expect(exchangeThalesForOver.connect(owner).setThales(newAddress))
				.to.emit(exchangeThalesForOver, 'SetThales')
				.withArgs(newAddress);

			// Test SetOver event
			await expect(exchangeThalesForOver.connect(owner).setOver(newAddress))
				.to.emit(exchangeThalesForOver, 'SetOver')
				.withArgs(newAddress);

			// Transfer some tokens to test WithdrawnCollateral event
			await overToken.connect(owner).transfer(exchangeThalesForOver.target, amount);
			await expect(
				exchangeThalesForOver.connect(owner).withdrawCollateral(overToken.target, amount)
			)
				.to.emit(exchangeThalesForOver, 'WithdrawnCollateral')
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
