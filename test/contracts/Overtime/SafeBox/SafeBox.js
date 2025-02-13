const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { upgrades } = require('hardhat');

describe('SportsAMMV2LiquidityPool Trades', () => {
	let collateral, owner, safeBox;

	beforeEach(async () => {
		({ collateral, owner } = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));
		const SafeBoxContract = await ethers.getContractFactory('SafeBox');
		safeBox = await upgrades.deployProxy(SafeBoxContract, [owner.address]);
	});

	describe('Initialization', function () {
		it('should initialize with the correct owner', async function () {
			expect(await safeBox.owner()).to.equal(owner.address);
		});

		it('should not allow re-initialization', async function () {
			await expect(safeBox.initialize(owner.address)).to.be.reverted;
		});
	});

	describe('Withdraw Collateral', function () {
		it('should allow owner to withdraw tokens to a specified recipient', async function () {
			const withdrawAmount = ethers.parseEther('1');
			await collateral.transfer(safeBox.target, withdrawAmount);
			// Get the recipient's token balance before withdrawal.
			const recipientBalanceBefore = await collateral.balanceOf(firstTrader.address);

			// The owner withdraws tokens and sends them to an explicit recipient address.
			await expect(
				safeBox.withdrawCollateral(collateral.target, firstTrader.address, withdrawAmount)
			)
				.to.emit(safeBox, 'WithdrawnCollateral')
				.withArgs(collateral.target, firstTrader.address, withdrawAmount);

			// Also confirm that the SafeBox's token balance has decreased.
			const safeBoxBalanceAfter = await collateral.balanceOf(safeBox.target);
			expect(safeBoxBalanceAfter).to.equal(0);

			// Confirm the recipient's balance increased accordingly.
			const recipientBalanceAfter = await collateral.balanceOf(firstTrader.address);
			expect(Number(recipientBalanceAfter) > Number(recipientBalanceBefore)).to.equal(true);
		});

		it('should withdraw tokens to owner when recipient is the zero address', async function () {
			const withdrawAmount = ethers.parseEther('5');
			const originalOwnerBalance = await collateral.balanceOf(owner.address);
			await collateral.transfer(safeBox.target, withdrawAmount);
			const ownerBalanceBefore = await collateral.balanceOf(owner.address);

			// When the zero address is provided, the tokens should be sent to the owner.
			await expect(safeBox.withdrawCollateral(collateral.target, ZERO_ADDRESS, withdrawAmount))
				.to.emit(safeBox, 'WithdrawnCollateral')
				.withArgs(collateral.target, owner.address, withdrawAmount);

			const ownerBalanceAfter = await collateral.balanceOf(owner.address);
			expect(ownerBalanceAfter).to.equal(originalOwnerBalance);

			const safeBoxBalanceAfter = await collateral.balanceOf(safeBox.target);
			expect(safeBoxBalanceAfter).to.equal(0);
		});

		it('should revert if a non-owner attempts to withdraw tokens', async function () {
			const withdrawAmount = ethers.parseEther('10');

			await expect(
				safeBox
					.connect(firstTrader)
					.withdrawCollateral(collateral.target, firstTrader.address, withdrawAmount)
			).to.be.reverted;
		});
	});
});
