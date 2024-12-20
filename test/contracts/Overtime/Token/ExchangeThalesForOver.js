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
				exchangeThalesForOver.connect(firstTrader).exchangeThalesForOver(exchangeAmount)
			).to.be.revertedWithCustomError(
				overToken,
				'ERC20InsufficientBalance(address,uint256,uint256)'
			);

			await overToken.connect(owner).transfer(exchangeThalesForOver.target, exchangeAmount);

			// Perform exchange
			await exchangeThalesForOver.connect(firstTrader).exchangeThalesForOver(exchangeAmount);

			// Get final balances
			const finalThalesBalance = await thalesToken.balanceOf(firstTrader.address);
			const finalOverBalance = await overToken.balanceOf(firstTrader.address);

			// Verify exchange occurred correctly
			expect(finalThalesBalance).to.equal(initialThalesBalance - exchangeAmount);
			expect(finalOverBalance).to.be.gt(initialOverBalance);
		});

		it('Should revert when exchange amount is zero', async () => {
			await expect(
				exchangeThalesForOver.connect(firstTrader).exchangeThalesForOver(0)
			).to.be.revertedWithCustomError(exchangeThalesForOver, 'AmountIsZero()');
		});

		it('Should revert when user has insufficient balance', async () => {
			const largeAmount = ethers.parseEther('1000000');
			await expect(
				exchangeThalesForOver.connect(firstTrader).exchangeThalesForOver(largeAmount)
			).to.be.revertedWithCustomError(thalesToken, 'ERC20InsufficientAllowance');
		});
		it('Should revert when user has insufficient balance', async () => {
			const largeAmount = ethers.parseEther('1000000');
			await thalesToken.connect(firstTrader).approve(exchangeThalesForOver.target, largeAmount);
			await expect(
				exchangeThalesForOver.connect(firstTrader).exchangeThalesForOver(largeAmount)
			).to.be.revertedWithCustomError(
				thalesToken,
				'ERC20InsufficientBalance(address,uint256,uint256)'
			);
		});

		it('Should revert when contract is paused', async () => {
			const exchangeAmount = ethers.parseEther('100');
			await exchangeThalesForOver.setPaused(true);

			await expect(
				exchangeThalesForOver.connect(firstTrader).exchangeThalesForOver(exchangeAmount)
			).to.be.revertedWith('This action cannot be performed while the contract is paused');
		});
	});
});
