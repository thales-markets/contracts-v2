const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_LP_INITAL_PARAMS } = require('./constants/overtimeContractParams');
const { ZERO_ADDRESS, MAX_NUMBER, ONE_WEEK_IN_SECS } = require('./constants/general');

describe('SportsAMMV2LiquidityPool Deployment and Setters', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolRoundMastercopy,
		defaultLiquidityProvider,
		collateral,
		stakingThales,
		safeBox,
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		firstLiquidityProvider,
		secondLiquidityProvider,
		thirdLiquidityProvider;

	beforeEach(async () => {
		const sportsAMMV2Fixture = await loadFixture(deploySportsAMMV2Fixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		sportsAMMV2 = sportsAMMV2Fixture.sportsAMMV2;
		sportsAMMV2LiquidityPool = sportsAMMV2Fixture.sportsAMMV2LiquidityPool;
		sportsAMMV2LiquidityPoolRoundMastercopy =
			sportsAMMV2Fixture.sportsAMMV2LiquidityPoolRoundMastercopy;
		defaultLiquidityProvider = sportsAMMV2Fixture.defaultLiquidityProvider;
		collateral = sportsAMMV2Fixture.collateral;
		stakingThales = sportsAMMV2Fixture.stakingThales;
		safeBox = sportsAMMV2Fixture.safeBox;
		owner = sportsAMMV2Fixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
		fourthAccount = accountsFixture.fourthAccount;
		firstLiquidityProvider = accountsFixture.firstLiquidityProvider;
		secondLiquidityProvider = accountsFixture.secondLiquidityProvider;
		thirdLiquidityProvider = accountsFixture.thirdLiquidityProvider;
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2LiquidityPool.owner()).to.equal(owner.address);
		});

		it('Should set the right addresses', async () => {
			expect(await sportsAMMV2LiquidityPool.collateral()).to.equal(await collateral.getAddress());
			expect(await sportsAMMV2LiquidityPool.stakingThales()).to.equal(
				await stakingThales.getAddress()
			);
			expect(await sportsAMMV2LiquidityPool.safeBox()).to.equal(safeBox.address);
			expect(await sportsAMMV2LiquidityPool.sportsAMM()).to.equal(await sportsAMMV2.getAddress());
		});

		it('Should set the right amounts', async () => {
			expect(await sportsAMMV2LiquidityPool.maxAllowedDeposit()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedDeposit
			);
			expect(await sportsAMMV2LiquidityPool.minDepositAmount()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.minDepositAmount
			);
			expect(await sportsAMMV2LiquidityPool.maxAllowedUsers()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedUsers
			);
			expect(await sportsAMMV2LiquidityPool.utilizationRate()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.utilizationRate
			);
			expect(await sportsAMMV2LiquidityPool.safeBoxImpact()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.safeBoxImpact
			);
		});

		it('Should set the right times', async () => {
			expect(await sportsAMMV2LiquidityPool.roundLength()).to.equal(
				SPORTS_AMM_LP_INITAL_PARAMS.roundLength
			);
		});

		it('Should set the right round pool mastercopy', async () => {
			expect(await sportsAMMV2LiquidityPool.poolRoundMastercopy()).to.equal(
				await sportsAMMV2LiquidityPoolRoundMastercopy.getAddress()
			);
		});
		it('Should set the right default liquidity provider', async () => {
			expect(await sportsAMMV2LiquidityPool.defaultLiquidityProvider()).to.equal(
				await defaultLiquidityProvider.getAddress()
			);
		});
	});

	describe('Setters', () => {
		let dummyAddress1;

		beforeEach(() => {
			dummyAddress1 = thirdAccount.address;
		});

		it('Should set the new Staking Thales', async () => {
			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setStakingThales(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await expect(sportsAMMV2LiquidityPool.setStakingThales(ZERO_ADDRESS)).to.be.revertedWith(
				'Can not set a zero address!'
			);

			await sportsAMMV2LiquidityPool.setStakingThales(dummyAddress1);
			expect(await sportsAMMV2LiquidityPool.stakingThales()).to.equal(dummyAddress1);

			await expect(sportsAMMV2LiquidityPool.setStakingThales(dummyAddress1))
				.to.emit(sportsAMMV2LiquidityPool, 'StakingThalesChanged')
				.withArgs(dummyAddress1);
		});

		it('Should set the new default liquidity provider', async () => {
			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setDefaultLiquidityProvider(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await expect(
				sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(ZERO_ADDRESS)
			).to.be.revertedWith('Can not set a zero address!');

			await sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(dummyAddress1);
			expect(await sportsAMMV2LiquidityPool.defaultLiquidityProvider()).to.equal(dummyAddress1);

			await expect(sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(dummyAddress1))
				.to.emit(sportsAMMV2LiquidityPool, 'DefaultLiquidityProviderChanged')
				.withArgs(dummyAddress1);
		});

		it('Should set the new round pool mastercopy', async () => {
			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setPoolRoundMastercopy(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await expect(
				sportsAMMV2LiquidityPool.setPoolRoundMastercopy(ZERO_ADDRESS)
			).to.be.revertedWith('Can not set a zero address!');

			await sportsAMMV2LiquidityPool.setPoolRoundMastercopy(dummyAddress1);
			expect(await sportsAMMV2LiquidityPool.poolRoundMastercopy()).to.equal(dummyAddress1);

			await expect(sportsAMMV2LiquidityPool.setPoolRoundMastercopy(dummyAddress1))
				.to.emit(sportsAMMV2LiquidityPool, 'PoolRoundMastercopyChanged')
				.withArgs(dummyAddress1);
		});

		it('Should set the new Sports AMM', async () => {
			let curentSportsAmmAllowance = await collateral.allowance(
				await sportsAMMV2LiquidityPool.getAddress(),
				await sportsAMMV2.getAddress()
			);
			expect(curentSportsAmmAllowance).to.equal(MAX_NUMBER);

			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setSportsAMM(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await expect(sportsAMMV2LiquidityPool.setSportsAMM(ZERO_ADDRESS)).to.be.revertedWith(
				'Can not set a zero address!'
			);

			await sportsAMMV2LiquidityPool.setSportsAMM(dummyAddress1);
			expect(await sportsAMMV2LiquidityPool.sportsAMM()).to.equal(dummyAddress1);

			curentLpAllowance = await collateral.allowance(
				await sportsAMMV2LiquidityPool.getAddress(),
				await dummyAddress1
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			const oldSportsAmmAllowance = await collateral.allowance(
				await sportsAMMV2LiquidityPool.getAddress(),
				await sportsAMMV2.getAddress()
			);
			expect(oldSportsAmmAllowance).to.equal(0);

			await expect(sportsAMMV2LiquidityPool.setSportsAMM(dummyAddress1))
				.to.emit(sportsAMMV2LiquidityPool, 'SportAMMChanged')
				.withArgs(dummyAddress1);
		});

		it('Should set the new max allowed deposit', async () => {
			const newMaxAllowedDeposit = ethers.parseEther('100000');

			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setMaxAllowedDeposit(newMaxAllowedDeposit)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2LiquidityPool.setMaxAllowedDeposit(newMaxAllowedDeposit);
			expect(await sportsAMMV2LiquidityPool.maxAllowedDeposit()).to.equal(newMaxAllowedDeposit);

			await expect(sportsAMMV2LiquidityPool.setMaxAllowedDeposit(newMaxAllowedDeposit))
				.to.emit(sportsAMMV2LiquidityPool, 'MaxAllowedDepositChanged')
				.withArgs(newMaxAllowedDeposit);
		});

		it('Should set the new min deposit amount', async () => {
			const newMinDepositAmount = ethers.parseEther('10');

			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setMinAllowedDeposit(newMinDepositAmount)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2LiquidityPool.setMinAllowedDeposit(newMinDepositAmount);
			expect(await sportsAMMV2LiquidityPool.minDepositAmount()).to.equal(newMinDepositAmount);

			await expect(sportsAMMV2LiquidityPool.setMinAllowedDeposit(newMinDepositAmount))
				.to.emit(sportsAMMV2LiquidityPool, 'MinAllowedDepositChanged')
				.withArgs(newMinDepositAmount);
		});

		it('Should set the new max allowed users', async () => {
			const newMaxAllowedUsers = 200;

			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setMaxAllowedUsers(newMaxAllowedUsers)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2LiquidityPool.setMaxAllowedUsers(newMaxAllowedUsers);
			expect(await sportsAMMV2LiquidityPool.maxAllowedUsers()).to.equal(newMaxAllowedUsers);

			await expect(sportsAMMV2LiquidityPool.setMaxAllowedUsers(newMaxAllowedUsers))
				.to.emit(sportsAMMV2LiquidityPool, 'MaxAllowedUsersChanged')
				.withArgs(newMaxAllowedUsers);
		});

		it('Should set the new round length', async () => {
			const newRoundLength = 2 * ONE_WEEK_IN_SECS;

			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setRoundLength(newRoundLength)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2LiquidityPool.setRoundLength(newRoundLength);
			expect(await sportsAMMV2LiquidityPool.roundLength()).to.equal(newRoundLength);

			await expect(sportsAMMV2LiquidityPool.setRoundLength(newRoundLength))
				.to.emit(sportsAMMV2LiquidityPool, 'RoundLengthChanged')
				.withArgs(newRoundLength);

			await sportsAMMV2LiquidityPool
				.connect(firstLiquidityProvider)
				.deposit(ethers.parseEther('100'));
			// start pool
			await sportsAMMV2LiquidityPool.start();

			await expect(sportsAMMV2LiquidityPool.setRoundLength(newRoundLength)).to.be.revertedWith(
				"Can't change round length after start"
			);
		});

		it('Should set the new utilization rate', async () => {
			const newUtilizationRate = ethers.parseEther('0.25');

			await expect(
				sportsAMMV2LiquidityPool.connect(secondAccount).setUtilizationRate(newUtilizationRate)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2LiquidityPool.setUtilizationRate(newUtilizationRate);
			expect(await sportsAMMV2LiquidityPool.utilizationRate()).to.equal(newUtilizationRate);

			await expect(sportsAMMV2LiquidityPool.setUtilizationRate(newUtilizationRate))
				.to.emit(sportsAMMV2LiquidityPool, 'UtilizationRateChanged')
				.withArgs(newUtilizationRate);
		});

		it('Should set the new safe box params', async () => {
			const newSafeBoxImpact = ethers.parseEther('0.25');

			await expect(
				sportsAMMV2LiquidityPool
					.connect(secondAccount)
					.setSafeBoxParams(dummyAddress1, newSafeBoxImpact)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2LiquidityPool.setSafeBoxParams(dummyAddress1, newSafeBoxImpact);
			expect(await sportsAMMV2LiquidityPool.safeBox()).to.equal(dummyAddress1);
			expect(await sportsAMMV2LiquidityPool.safeBoxImpact()).to.equal(newSafeBoxImpact);

			await expect(sportsAMMV2LiquidityPool.setSafeBoxParams(dummyAddress1, newSafeBoxImpact))
				.to.emit(sportsAMMV2LiquidityPool, 'SetSafeBoxParams')
				.withArgs(dummyAddress1, newSafeBoxImpact);
		});
	});
});
