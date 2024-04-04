const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { MAX_NUMBER } = require('../../../constants/general');
const { ETH_DEFAULT_AMOUNT } = require('../../../constants/overtime');
const { ethers } = require('hardhat');

describe('DefaultLiquidityProvider', () => {
	let defaultLiquidityProviderETH,
		sportsAMMV2LiquidityPoolETH,
		collateral,
		weth,
		owner,
		secondAccount,
		thirdAccount,
		defaultLiquidityProviderAddress;

	beforeEach(async () => {
		({ defaultLiquidityProviderETH, sportsAMMV2LiquidityPoolETH, collateral, weth, owner } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture));

		defaultLiquidityProviderAddress = await defaultLiquidityProviderETH.getAddress();
		collateral = weth;
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await defaultLiquidityProviderETH.owner()).to.equal(owner.address);
		});

		it('Should set the right collateral', async () => {
			expect(await defaultLiquidityProviderETH.collateral()).to.equal(
				await collateral.getAddress()
			);
		});

		it('Should set the right liquidity pool', async () => {
			expect(await defaultLiquidityProviderETH.liquidityPool()).to.equal(
				await sportsAMMV2LiquidityPoolETH.getAddress()
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new liquidity pool', async () => {
			const dummyAddress1 = thirdAccount.address;

			let curentLpAllowance = await collateral.allowance(
				await defaultLiquidityProviderETH.getAddress(),
				await sportsAMMV2LiquidityPoolETH.getAddress()
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			await expect(
				defaultLiquidityProviderETH.connect(secondAccount).setLiquidityPool(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await defaultLiquidityProviderETH.setLiquidityPool(dummyAddress1);
			expect(await defaultLiquidityProviderETH.liquidityPool()).to.equal(dummyAddress1);

			curentLpAllowance = await collateral.allowance(
				await defaultLiquidityProviderETH.getAddress(),
				dummyAddress1
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			const oldLpAllowance = await collateral.allowance(
				await defaultLiquidityProviderETH.getAddress(),
				await sportsAMMV2LiquidityPoolETH.getAddress()
			);
			expect(oldLpAllowance).to.equal(0);

			await expect(defaultLiquidityProviderETH.setLiquidityPool(dummyAddress1))
				.to.emit(defaultLiquidityProviderETH, 'SetLiquidityPool')
				.withArgs(dummyAddress1);
		});
	});

	describe('Retrieve collateral amount', () => {
		it('Should retrieve collateral amount', async () => {
			const dummyAddress1 = thirdAccount.address;
			const parsedAmountToRetrieve = ethers.parseEther('2');

			await expect(
				defaultLiquidityProviderETH
					.connect(secondAccount)
					.retrieveCollateralAmount(dummyAddress1, parsedAmountToRetrieve)
			).to.be.revertedWith('Only the contract owner may perform this action');

			let currentDefaultLpBalance = await collateral.balanceOf(defaultLiquidityProviderAddress);
			expect(currentDefaultLpBalance).to.equal(ETH_DEFAULT_AMOUNT);

			await defaultLiquidityProviderETH.retrieveCollateralAmount(
				dummyAddress1,
				parsedAmountToRetrieve
			);

			currentDefaultLpBalance = await collateral.balanceOf(defaultLiquidityProviderAddress);
			expect(currentDefaultLpBalance).to.equal(ethers.parseEther('3'));

			const dummyAddress1Balance = await collateral.balanceOf(dummyAddress1);
			expect(dummyAddress1Balance).to.equal(ethers.parseEther('2'));
		});
	});
});
