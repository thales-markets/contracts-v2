const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { MAX_NUMBER } = require('./constants/general');
const { DEFAULT_AMOUNT } = require('./constants/overtime');
const { ethers } = require('hardhat');

describe('DefaultLiquidityProvider', () => {
	let defaultLiquidityProvider,
		sportsAMMV2LiquidityPool,
		collateral,
		owner,
		secondAccount,
		thirdAccount,
		defaultLiquidityProviderAddress;

	beforeEach(async () => {
		const sportsAMMV2Fixture = await loadFixture(deploySportsAMMV2Fixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		defaultLiquidityProvider = sportsAMMV2Fixture.defaultLiquidityProvider;
		sportsAMMV2LiquidityPool = sportsAMMV2Fixture.sportsAMMV2LiquidityPool;
		collateral = sportsAMMV2Fixture.collateral;
		owner = sportsAMMV2Fixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;

		defaultLiquidityProviderAddress = await defaultLiquidityProvider.getAddress();
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await defaultLiquidityProvider.owner()).to.equal(owner.address);
		});

		it('Should set the right collateral', async () => {
			expect(await defaultLiquidityProvider.collateral()).to.equal(await collateral.getAddress());
		});

		it('Should set the right liquidity pool', async () => {
			expect(await defaultLiquidityProvider.liquidityPool()).to.equal(
				await sportsAMMV2LiquidityPool.getAddress()
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new liquidity pool', async () => {
			const dummyAddress1 = thirdAccount.address;

			let curentLpAllowance = await collateral.allowance(
				await defaultLiquidityProvider.getAddress(),
				await sportsAMMV2LiquidityPool.getAddress()
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			await expect(
				defaultLiquidityProvider.connect(secondAccount).setLiquidityPool(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await defaultLiquidityProvider.setLiquidityPool(dummyAddress1);
			expect(await defaultLiquidityProvider.liquidityPool()).to.equal(dummyAddress1);

			curentLpAllowance = await collateral.allowance(
				await defaultLiquidityProvider.getAddress(),
				dummyAddress1
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			const oldLpAllowance = await collateral.allowance(
				await defaultLiquidityProvider.getAddress(),
				await sportsAMMV2LiquidityPool.getAddress()
			);
			expect(oldLpAllowance).to.equal(0);

			await expect(defaultLiquidityProvider.setLiquidityPool(dummyAddress1))
				.to.emit(defaultLiquidityProvider, 'SetLiquidityPool')
				.withArgs(dummyAddress1);
		});
	});

	describe('Retrieve collateral amount', () => {
		it('Should retrieve collateral amount', async () => {
			const dummyAddress1 = thirdAccount.address;
			const parsedAmountToRetrieve = ethers.parseEther('2000');

			await expect(
				defaultLiquidityProvider
					.connect(secondAccount)
					.retrieveCollateralAmount(dummyAddress1, parsedAmountToRetrieve)
			).to.be.revertedWith('Only the contract owner may perform this action');

			let currentDefaultLpBalance = await collateral.balanceOf(defaultLiquidityProviderAddress);
			expect(currentDefaultLpBalance).to.equal(DEFAULT_AMOUNT);

			await defaultLiquidityProvider.retrieveCollateralAmount(
				dummyAddress1,
				parsedAmountToRetrieve
			);

			currentDefaultLpBalance = await collateral.balanceOf(defaultLiquidityProviderAddress);
			expect(currentDefaultLpBalance).to.equal(ethers.parseEther('8000'));

			const dummyAddress1Balance = await collateral.balanceOf(dummyAddress1);
			expect(dummyAddress1Balance).to.equal(ethers.parseEther('2000'));
		});
	});
});
