const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_LP_INITAL_PARAMS } = require('./constants/overtimeContractParams');
const { ZERO_ADDRESS } = require('./constants/general');

describe('SportsAMMV2LiquidityPool', () => {
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

	describe('Start liqudiity pool', () => {
		it('Should fail with "Only the contract owner may perform this action"', async () => {
			await expect(sportsAMMV2LiquidityPool.connect(secondAccount).start()).to.be.revertedWith(
				'Only the contract owner may perform this action'
			);
		});

		it('Should fail with "Can not start with 0 deposits"', async () => {
			await expect(sportsAMMV2LiquidityPool.start()).to.be.revertedWith(
				'Can not start with 0 deposits'
			);
		});

		it('Should start liquidity pool', async () => {
			const initialDeposit = ethers.parseEther('1000');
			await sportsAMMV2LiquidityPool.connect(firstLiquidityProvider).deposit(initialDeposit);

			await sportsAMMV2LiquidityPool.start();

			const roundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(2);

			expect(await sportsAMMV2LiquidityPool.started()).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.round()).to.equal(2);
			expect(roundPoolAddress).not.to.equal(ZERO_ADDRESS);
			expect(await collateral.balanceOf(roundPoolAddress)).to.equal(initialDeposit);

			await expect(sportsAMMV2LiquidityPool.start()).to.be.revertedWith('LP has already started');
		});
	});

	describe('Deposits', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider,
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider,
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(secondLiquidityProvider);
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(thirdLiquidityProvider);
		});

		it('Should fail with "Amount less than minDepositAmount"', async () => {
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('10'))
			).to.be.revertedWith('Amount less than minDepositAmount');
		});

		it('Should fail with "Deposit amount exceeds AMM LP cap"', async () => {
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('30000'))
			).to.be.revertedWith('Deposit amount exceeds AMM LP cap');
		});

		it('Should fail with "Can\'t deposit directly as default LP"', async () => {
			await sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(firstLiquidityProvider);

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'))
			).to.be.revertedWith("Can't deposit directly as default LP");
		});

		it('Should fail with "Max amount of users reached"', async () => {
			await sportsAMMV2LiquidityPool.setMaxAllowedUsers(1);
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));

			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);

			await expect(
				sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(ethers.parseEther('100'))
			).to.be.revertedWith('Max amount of users reached');

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);
		});

		it('Should deposit into liquidity pool', async () => {
			const firstRoundAfterStart = 2;

			// firstLiquidityProvider deposit for round 2
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);
			expect(await sportsAMMV2LiquidityPool.usersPerRound(firstRoundAfterStart, 0)).to.equal(
				firstLiquidityProvider.address
			);
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(
					firstRoundAfterStart,
					firstLiquidityProvider
				)
			).to.equal(ethers.parseEther('100'));

			// pool check
			let firstRoundAfterStartPoolAddress =
				await sportsAMMV2LiquidityPool.roundPools(firstRoundAfterStart);
			expect(firstRoundAfterStartPoolAddress).not.to.equal(ZERO_ADDRESS);

			// allocation and pool balances check
			expect(await collateral.balanceOf(firstRoundAfterStartPoolAddress)).to.equal(
				ethers.parseEther('100')
			);
			expect(await sportsAMMV2LiquidityPool.totalDeposited()).to.equal(ethers.parseEther('100'));
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(firstRoundAfterStart)).to.equal(
				ethers.parseEther('100')
			);

			// secondLiquidityProvider deposit for round 2
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(ethers.parseEther('200'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(2);
			expect(await sportsAMMV2LiquidityPool.usersPerRound(firstRoundAfterStart, 1)).to.equal(
				secondLiquidityProvider.address
			);
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(
					firstRoundAfterStart,
					secondLiquidityProvider
				)
			).to.equal(ethers.parseEther('200'));

			// allocation and pool balances check
			expect(await collateral.balanceOf(firstRoundAfterStartPoolAddress)).to.equal(
				ethers.parseEther('300')
			);
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(firstRoundAfterStart)).to.equal(
				ethers.parseEther('300')
			);
			expect(await sportsAMMV2LiquidityPool.totalDeposited()).to.equal(ethers.parseEther('300'));

			// start pool
			await sportsAMMV2LiquidityPool.start();
			let currentRound = await sportsAMMV2LiquidityPool.round();
			expect(currentRound).to.equal(2);
			expect(await sportsAMMV2LiquidityPool.getUsersCountInCurrentRound()).to.equal(2);

			// await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));
			// expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(2);

			let nextRound = Number(currentRound) + 1;

			// firstLiquidityProvider deposit for round 3
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('150'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(2);
			// check for current round
			expect(await sportsAMMV2LiquidityPool.usersPerRound(currentRound, 0)).to.equal(
				firstLiquidityProvider.address
			);
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(currentRound, firstLiquidityProvider)
			).to.equal(ethers.parseEther('100'));
			// check for next round
			// expect(await sportsAMMV2LiquidityPool.usersPerRound(nextRound, 0)).to.equal(
			// 	firstLiquidityProvider.address
			// );
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(nextRound, firstLiquidityProvider)
			).to.equal(ethers.parseEther('150'));

			// thirdiquidityProvider deposit for round 3
			await sportsAMMV2LiquidityPoolWithThirdLiquidityProvider.deposit(ethers.parseEther('300'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(3);
			// check for next round
			expect(await sportsAMMV2LiquidityPool.usersPerRound(nextRound, 0)).to.equal(
				thirdLiquidityProvider.address
			);
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(nextRound, thirdLiquidityProvider)
			).to.equal(ethers.parseEther('300'));

			// allocation and pool balances check for current round
			let currentRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(currentRound);
			expect(await collateral.balanceOf(currentRoundPoolAddress)).to.equal(
				ethers.parseEther('300')
			);
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(currentRound)).to.equal(
				ethers.parseEther('300')
			);

			// allocation and pool balances check for next round
			let nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			expect(nextRoundPoolAddress).not.to.equal(ZERO_ADDRESS);
			expect(await collateral.balanceOf(nextRoundPoolAddress)).to.equal(ethers.parseEther('450'));
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound)).to.equal(
				ethers.parseEther('450')
			);
			expect(await sportsAMMV2LiquidityPool.totalDeposited()).to.equal(ethers.parseEther('750'));
		});
	});

	describe('Withdrawals', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider,
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider,
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(secondLiquidityProvider);
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(thirdLiquidityProvider);
		});

		it('Should fail with "Pool has not started"', async () => {
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest()
			).to.be.revertedWith('Pool has not started');

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
					ethers.parseEther('20')
				)
			).to.be.revertedWith('Pool has not started');
		});

		it('Should fail with "Nothing to withdraw"', async () => {
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(ethers.parseEther('200'));

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest()
			).to.be.revertedWith('Nothing to withdraw');

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
					ethers.parseEther('20')
				)
			).to.be.revertedWith('Nothing to withdraw');
		});

		it('Should fail with "Can\'t withdraw as you already deposited for next round"', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest()
			).to.be.revertedWith("Can't withdraw as you already deposited for next round");

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
					ethers.parseEther('20')
				)
			).to.be.revertedWith("Can't withdraw as you already deposited for next round");
		});

		it('Should fail with "Withdrawal already requested"', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest();

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest()
			).to.be.revertedWith('Withdrawal already requested');

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
					ethers.parseEther('20')
				)
			).to.be.revertedWith('Withdrawal already requested');
		});

		it('Deposit should fail with "Withdrawal is requested, cannot deposit"', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'));

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest();

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'))
			).to.be.revertedWith('Withdrawal is requested, cannot deposit');
		});
	});
});
