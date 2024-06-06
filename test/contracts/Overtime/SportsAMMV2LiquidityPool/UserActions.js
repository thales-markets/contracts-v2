const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
} = require('../../../constants/overtime');

describe('SportsAMMV2LiquidityPool User Actions', () => {
	let sportsAMMV2,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		collateral,
		tradeDataCurrentRound,
		secondAccount,
		firstLiquidityProvider,
		secondLiquidityProvider,
		thirdLiquidityProvider,
		firstTrader;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			collateral,
			tradeDataCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({
			secondAccount,
			firstLiquidityProvider,
			secondLiquidityProvider,
			thirdLiquidityProvider,
			firstTrader,
		} = await loadFixture(deployAccountsFixture));

		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
			[0, TYPE_ID_TOTAL, TYPE_ID_SPREAD, TYPE_ID_WINNER_TOTAL],
			[
				RESULT_TYPE.ExactPosition,
				RESULT_TYPE.OverUnder,
				RESULT_TYPE.Spread,
				RESULT_TYPE.CombinedPositions,
			]
		);
	});

	describe('Start liquidity pool', () => {
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

			const round = await sportsAMMV2LiquidityPool.round();
			const roundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(round);

			expect(await sportsAMMV2LiquidityPool.started()).to.equal(true);
			expect(round).to.equal(2);
			expect(roundPoolAddress).not.to.equal(ZERO_ADDRESS);
			expect(await collateral.balanceOf(roundPoolAddress)).to.equal(initialDeposit);

			const roundStartTime = Number(await sportsAMMV2LiquidityPool.getRoundStartTime(round));
			const roundEndTime = Number(await sportsAMMV2LiquidityPool.getRoundEndTime(round));
			const roundLength = Number(await sportsAMMV2LiquidityPool.roundLength());

			expect(await sportsAMMV2LiquidityPool.firstRoundStartTime()).to.equal(roundStartTime);
			expect(roundStartTime + roundLength).to.equal(roundEndTime);

			await expect(sportsAMMV2LiquidityPool.start()).to.be.revertedWith('LP has already started');
		});

		it('Should emit PoolStarted event', async () => {
			const initialDeposit = ethers.parseEther('1000');
			await sportsAMMV2LiquidityPool.connect(firstLiquidityProvider).deposit(initialDeposit);

			await expect(sportsAMMV2LiquidityPool.start()).to.emit(
				sportsAMMV2LiquidityPool,
				'PoolStarted'
			);
		});

		it('Should fail with "Can\'t close current round" when pool not started', async () => {
			await expect(sportsAMMV2LiquidityPool.prepareRoundClosing()).to.be.revertedWith(
				"Can't close current round"
			);
		});
	});

	describe('Deposits', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider,
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider,
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider,
			defaultDepositAmount;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(secondLiquidityProvider);
			sportsAMMV2LiquidityPoolWithThirdLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(thirdLiquidityProvider);
			defaultDepositAmount = ethers.parseEther('100');
		});

		it('Should fail with "Amount less than minDepositAmount"', async () => {
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('10'))
			).to.be.revertedWith('Amount less than minDepositAmount');
		});

		it('Should fail with "Deposit amount exceeds AMM LP cap"', async () => {
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('300000'))
			).to.be.revertedWith('Deposit amount exceeds AMM LP cap');
		});

		it('Should fail with "Can\'t deposit directly as default LP"', async () => {
			await sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(firstLiquidityProvider);

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount)
			).to.be.revertedWith("Can't deposit directly as default LP");
		});

		it('Should fail with "Max amount of users reached"', async () => {
			await sportsAMMV2LiquidityPool.setMaxAllowedUsers(1);
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);

			await expect(
				sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(defaultDepositAmount)
			).to.be.revertedWith('Max amount of users reached');

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);
		});

		it('Should deposit into liquidity pool', async () => {
			const firstRoundAfterStart = 2;

			// firstLiquidityProvider deposit for round 2
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.isUserLPing(firstLiquidityProvider)).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);
			expect(await sportsAMMV2LiquidityPool.usersPerRound(firstRoundAfterStart, 0)).to.equal(
				firstLiquidityProvider.address
			);
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(
					firstRoundAfterStart,
					firstLiquidityProvider
				)
			).to.equal(defaultDepositAmount);

			// pool check
			let firstRoundAfterStartPoolAddress =
				await sportsAMMV2LiquidityPool.roundPools(firstRoundAfterStart);
			expect(firstRoundAfterStartPoolAddress).not.to.equal(ZERO_ADDRESS);

			// allocation and pool balances check
			expect(await collateral.balanceOf(firstRoundAfterStartPoolAddress)).to.equal(
				defaultDepositAmount
			);
			expect(await sportsAMMV2LiquidityPool.totalDeposited()).to.equal(defaultDepositAmount);
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(firstRoundAfterStart)).to.equal(
				defaultDepositAmount
			);

			// secondLiquidityProvider deposit for round 2
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(ethers.parseEther('200'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.isUserLPing(secondLiquidityProvider)).to.equal(true);
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

			let nextRound = Number(currentRound) + 1;

			// firstLiquidityProvider deposit for round 3
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('150'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.isUserLPing(firstLiquidityProvider)).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(2);
			// check for current round
			expect(await sportsAMMV2LiquidityPool.usersPerRound(currentRound, 0)).to.equal(
				firstLiquidityProvider.address
			);
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(currentRound, firstLiquidityProvider)
			).to.equal(defaultDepositAmount);
			// check for next round
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(nextRound, firstLiquidityProvider)
			).to.equal(ethers.parseEther('150'));

			// thirdLiquidityProvider deposit for round 3
			await sportsAMMV2LiquidityPoolWithThirdLiquidityProvider.deposit(ethers.parseEther('300'));
			// users and balances check
			expect(await sportsAMMV2LiquidityPool.isUserLPing(thirdLiquidityProvider)).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(3);
			// check for current round
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(currentRound, thirdLiquidityProvider)
			).to.equal(0);
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

		it('Should emit "Deposited" event', async () => {
			await expect(sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount))
				.to.emit(sportsAMMV2LiquidityPool, 'Deposited')
				.withArgs(firstLiquidityProvider.address, defaultDepositAmount, 1);
		});
	});

	describe('Withdrawals', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider,
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider,
			defaultDepositAmount;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(secondLiquidityProvider);
			defaultDepositAmount = ethers.parseEther('100');
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
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(defaultDepositAmount);

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
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

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
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

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
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest();

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount)
			).to.be.revertedWith('Withdrawal is requested, cannot deposit');
		});

		it('Should withdraw full amount', async () => {
			const firstDepositAmount = 100;
			const secondDepositAmount = 200;
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(
				ethers.parseEther(`${firstDepositAmount}`)
			);
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(
				ethers.parseEther(`${secondDepositAmount}`)
			);

			// start pool
			await sportsAMMV2LiquidityPool.start();

			const currentRound = Number(await sportsAMMV2LiquidityPool.round());
			const firstLiquidityProviderBalanceBefore = ethers.formatEther(
				await collateral.balanceOf(firstLiquidityProvider)
			);

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest();
			expect(await sportsAMMV2LiquidityPool.isUserLPing(firstLiquidityProvider)).to.equal(false);
			expect(await sportsAMMV2LiquidityPool.withdrawalRequested(firstLiquidityProvider)).to.equal(
				true
			);
			expect(await sportsAMMV2LiquidityPool.withdrawalShare(firstLiquidityProvider)).to.equal(0);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(1);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// increase time to round close time
			const currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			const nextRound = await sportsAMMV2LiquidityPool.round();

			// check withdrawal amount
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const firstLiquidityProviderBalanceAfter = ethers.formatEther(
				await collateral.balanceOf(firstLiquidityProvider)
			);

			const diffFirstLiquidityProviderBalance =
				firstLiquidityProviderBalanceAfter - firstLiquidityProviderBalanceBefore;

			const calculatedFirstLiquidityProviderWithdrawalAmount = firstDepositAmount * currentRoundPnl;

			expect(diffFirstLiquidityProviderBalance.toFixed(8)).to.equal(
				calculatedFirstLiquidityProviderWithdrawalAmount.toFixed(8)
			);

			// users balances check
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(nextRound, firstLiquidityProvider)
			).to.equal(0);

			// allocation and pool balances check
			const calculatedlpBalance = (secondDepositAmount * currentRoundPnl).toFixed(8);
			let nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);

			expect(
				Number(ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))).toFixed(8)
			).to.equal(calculatedlpBalance);
			expect(
				Number(ethers.formatEther(await sportsAMMV2LiquidityPool.totalDeposited())).toFixed(8)
			).to.equal(calculatedlpBalance);
			expect(
				Number(
					ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound))
				).toFixed(8)
			).to.equal(calculatedlpBalance);
		});

		it('Should withdraw full amount as last user', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest();
			expect(await sportsAMMV2LiquidityPool.isUserLPing(firstLiquidityProvider)).to.equal(false);
			expect(await sportsAMMV2LiquidityPool.withdrawalRequested(firstLiquidityProvider)).to.equal(
				true
			);
			expect(await sportsAMMV2LiquidityPool.withdrawalShare(firstLiquidityProvider)).to.equal(0);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(0);

			const currentRound = await sportsAMMV2LiquidityPool.round();
			const currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			const nextRound = await sportsAMMV2LiquidityPool.round();

			// users balances check
			expect(
				await sportsAMMV2LiquidityPool.balancesPerRound(nextRound, firstLiquidityProvider)
			).to.equal(0);

			// allocation and pool balances check
			let nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);
			expect(await collateral.balanceOf(nextRoundPoolAddress)).to.equal(0);
			expect(await sportsAMMV2LiquidityPool.totalDeposited()).to.equal(0);
			expect(await sportsAMMV2LiquidityPool.allocationPerRound(nextRoundPoolAddress)).to.equal(0);
		});

		it('Should fail with "Share has to be between 10% and 90%"', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(defaultDepositAmount);

			// start pool
			await sportsAMMV2LiquidityPool.start();

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
					ethers.parseEther('5')
				)
			).to.be.revertedWith('Share has to be between 10% and 90%');
		});

		it('Should withdraw partial amount - 30%', async () => {
			const firstDepositAmount = 100;
			const secondDepositAmount = 200;
			const withdrawalShare = 0.3;
			const parsedWithdrawalShare = ethers.parseEther(`${withdrawalShare}`);

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(
				ethers.parseEther(`${firstDepositAmount}`)
			);
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(
				ethers.parseEther(`${secondDepositAmount}`)
			);

			// start pool
			await sportsAMMV2LiquidityPool.start();

			const currentRound = Number(await sportsAMMV2LiquidityPool.round());
			const firstLiquidityProviderBalanceBefore = ethers.formatEther(
				await collateral.balanceOf(firstLiquidityProvider)
			);

			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
				parsedWithdrawalShare
			);
			expect(await sportsAMMV2LiquidityPool.isUserLPing(firstLiquidityProvider)).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.withdrawalRequested(firstLiquidityProvider)).to.equal(
				true
			);
			expect(await sportsAMMV2LiquidityPool.withdrawalShare(firstLiquidityProvider)).to.equal(
				parsedWithdrawalShare
			);
			expect(await sportsAMMV2LiquidityPool.usersCurrentlyInPool()).to.equal(2);

			// create a ticket
			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			// resolve ticket market as loss for the user
			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[1]]
			);

			// increase time to round close time
			const currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			// close round
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			const nextRound = await sportsAMMV2LiquidityPool.round();

			// check withdrawal amount
			const currentRoundPnl = Number(
				ethers.formatEther(await sportsAMMV2LiquidityPool.profitAndLossPerRound(currentRound))
			);
			const firstLiquidityProviderBalanceAfter = ethers.formatEther(
				await collateral.balanceOf(firstLiquidityProvider)
			);

			const diffFirstLiquidityProviderBalance =
				firstLiquidityProviderBalanceAfter - firstLiquidityProviderBalanceBefore;

			const calculatedFirstLiquidityProviderWithdrawalAmount =
				firstDepositAmount * currentRoundPnl * withdrawalShare;

			expect(diffFirstLiquidityProviderBalance.toFixed(8)).to.equal(
				calculatedFirstLiquidityProviderWithdrawalAmount.toFixed(8)
			);

			// users balances check
			const firstLiquidityProviderBalanceInPool = Number(
				ethers.formatEther(
					await sportsAMMV2LiquidityPool.balancesPerRound(nextRound, firstLiquidityProvider)
				)
			);
			const caluclatedFirstLiquidityProviderBalanceInPool =
				firstDepositAmount * currentRoundPnl - calculatedFirstLiquidityProviderWithdrawalAmount;
			expect(firstLiquidityProviderBalanceInPool.toFixed(8)).to.equal(
				caluclatedFirstLiquidityProviderBalanceInPool.toFixed(8)
			);

			// allocation and pool balances check
			const calculatedlpBalance = (
				secondDepositAmount * currentRoundPnl +
				caluclatedFirstLiquidityProviderBalanceInPool
			).toFixed(8);
			let nextRoundPoolAddress = await sportsAMMV2LiquidityPool.roundPools(nextRound);

			expect(
				Number(ethers.formatEther(await collateral.balanceOf(nextRoundPoolAddress))).toFixed(8)
			).to.equal(calculatedlpBalance);
			expect(
				Number(ethers.formatEther(await sportsAMMV2LiquidityPool.totalDeposited())).toFixed(8)
			).to.equal(calculatedlpBalance);
			expect(
				Number(
					ethers.formatEther(await sportsAMMV2LiquidityPool.allocationPerRound(nextRound))
				).toFixed(8)
			).to.equal(calculatedlpBalance);
		});
	});

	describe('Round closing', () => {
		let sportsAMMV2LiquidityPoolWithFirstLiquidityProvider,
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider,
			currentRound,
			currentRoundCloseTime;

		beforeEach(async () => {
			sportsAMMV2LiquidityPoolWithFirstLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(firstLiquidityProvider);
			sportsAMMV2LiquidityPoolWithSecondLiquidityProvider =
				sportsAMMV2LiquidityPool.connect(secondLiquidityProvider);

			// deposit and start pool
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('500'));
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.deposit(ethers.parseEther('500'));
			await sportsAMMV2LiquidityPool.start();

			currentRound = await sportsAMMV2LiquidityPool.round();
			currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				ZERO_ADDRESS,
				false
			);
			await sportsAMMV2
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					ZERO_ADDRESS,
					ZERO_ADDRESS,
					false
				);

			const ticketMarket1 = tradeDataCurrentRound[0];
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[ticketMarket1.gameId],
				[ticketMarket1.typeId],
				[ticketMarket1.playerId],
				[[0]]
			);
		});

		it('Should fail with "Can\'t close current round" - round not ended', async () => {
			await expect(sportsAMMV2LiquidityPool.prepareRoundClosing()).to.be.revertedWith(
				"Can't close current round"
			);
		});

		// it('Should fail with "Can\'t close current round" - postions not resolved', async () => {
		// 	await expect(sportsAMMV2LiquidityPool.prepareRoundClosing()).to.be.revertedWith(
		// 		"Can't close current round"
		// 	);
		// });

		it('Should be able to close current round"', async () => {
			await time.increaseTo(currentRoundCloseTime);
			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(true);
		});

		it('Should fail with "Round closing not prepared" on processing round closing', async () => {
			await time.increaseTo(currentRoundCloseTime);
			await expect(sportsAMMV2LiquidityPool.processRoundClosingBatch(10)).to.be.revertedWith(
				'Round closing not prepared'
			);
		});

		it('Should fail with "All users already processed"', async () => {
			await time.increaseTo(currentRoundCloseTime);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);

			await expect(sportsAMMV2LiquidityPool.processRoundClosingBatch(10)).to.be.revertedWith(
				'All users already processed'
			);
		});

		it('Should fail with "Batch size has to be greater than 0"', async () => {
			await time.increaseTo(currentRoundCloseTime);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();

			await expect(sportsAMMV2LiquidityPool.processRoundClosingBatch(0)).to.be.revertedWith(
				'Batch size has to be greater than 0'
			);
		});

		it('Should fail with "Round closing not prepared" on round closing', async () => {
			await time.increaseTo(currentRoundCloseTime);
			await expect(sportsAMMV2LiquidityPool.closeRound()).to.be.revertedWith(
				'Round closing not prepared'
			);
		});

		it('Should fail with "Not all users processed yet"', async () => {
			await time.increaseTo(currentRoundCloseTime);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(1);
			await expect(sportsAMMV2LiquidityPool.closeRound()).to.be.revertedWith(
				'Not all users processed yet'
			);
		});

		it('Should fail with "Not allowed during roundClosingPrepared"', async () => {
			await time.increaseTo(currentRoundCloseTime);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();

			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.deposit(ethers.parseEther('100'))
			).to.be.revertedWith('Not allowed during roundClosingPrepared');
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest()
			).to.be.revertedWith('Not allowed during roundClosingPrepared');
			await expect(
				sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.partialWithdrawalRequest(
					ethers.parseEther('0.3')
				)
			).to.be.revertedWith('Not allowed during roundClosingPrepared');
			await expect(sportsAMMV2LiquidityPool.prepareRoundClosing()).to.be.revertedWith(
				'Not allowed during roundClosingPrepared'
			);
			await expect(sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercised()).to.be.revertedWith(
				'Not allowed during roundClosingPrepared'
			);
			await expect(
				sportsAMMV2LiquidityPool.exerciseTicketsReadyToBeExercisedBatch(10)
			).to.be.revertedWith('Not allowed during roundClosingPrepared');
		});

		it('Should close round', async () => {
			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(false);

			await time.increaseTo(currentRoundCloseTime);

			expect(await sportsAMMV2LiquidityPool.canCloseCurrentRound()).to.equal(true);
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(false);
			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			expect(await sportsAMMV2LiquidityPool.roundClosingPrepared()).to.equal(true);
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			expect(await sportsAMMV2LiquidityPool.usersProcessedInRound()).to.equal(2);
			await sportsAMMV2LiquidityPool.closeRound();

			expect(await sportsAMMV2LiquidityPool.round()).to.equal(3);
		});

		it('Should emit round closing events', async () => {
			await time.increaseTo(currentRoundCloseTime);

			await expect(sportsAMMV2LiquidityPool.prepareRoundClosing())
				.to.emit(sportsAMMV2LiquidityPool, 'RoundClosingPrepared')
				.withArgs(currentRound);

			await expect(sportsAMMV2LiquidityPool.processRoundClosingBatch(10))
				.to.emit(sportsAMMV2LiquidityPool, 'RoundClosingBatchProcessed')
				.withArgs(currentRound, 10);

			await expect(sportsAMMV2LiquidityPool.closeRound())
				.to.emit(sportsAMMV2LiquidityPool, 'RoundClosed')
				.withArgs(currentRound, ethers.parseEther('0.9898'));
		});

		it('Should close round without allocation', async () => {
			await sportsAMMV2LiquidityPoolWithFirstLiquidityProvider.withdrawalRequest();
			await sportsAMMV2LiquidityPoolWithSecondLiquidityProvider.withdrawalRequest();

			let currentRound = await sportsAMMV2LiquidityPool.round();
			let currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.processRoundClosingBatch(10);
			await sportsAMMV2LiquidityPool.closeRound();

			currentRound = await sportsAMMV2LiquidityPool.round();
			expect(await sportsAMMV2LiquidityPool.totalDeposited()).to.equal(0);

			currentRoundCloseTime = await sportsAMMV2LiquidityPool.getRoundEndTime(currentRound);
			await time.increaseTo(currentRoundCloseTime);

			await sportsAMMV2LiquidityPool.prepareRoundClosing();
			await sportsAMMV2LiquidityPool.closeRound();

			expect(await sportsAMMV2LiquidityPool.round()).to.equal(4);
		});
	});
});
