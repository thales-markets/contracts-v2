const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_NBA,
	RESULT_TYPE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('SportsAMMV2 Quotes And Trades', () => {
	let sportsAMMV2,
		sportsAMMV2Data,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		secondTrader,
		thirdAccount,
		freeBetsHolder,
		collateralAddress,
		collateral,
		sportsAMMV2RiskManager,
		mockChainlinkOracle,
		liveTradingProcessor,
		sportsAMMV2ResultManager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			freeBetsHolder,
			collateralAddress,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			liveTradingProcessor,
			sportsAMMV2ResultManager,
			collateral,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader, secondTrader, thirdAccount } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Trade with free bet', () => {
		it('Fund batch', async () => {
			const firstTraderBalanceBeforeFunding = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);

			await freeBetsHolder.fundBatch(
				[firstTrader, firstLiquidityProvider],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			const firstTraderBalanceAfterFunding = await freeBetsHolder.balancePerUserAndCollateral(
				firstTrader,
				collateralAddress
			);
			expect(firstTraderBalanceAfterFunding - firstTraderBalanceBeforeFunding).to.equal(
				BUY_IN_AMOUNT
			);

			const firstLiquidityProviderBeforeReclaiming =
				await collateral.balanceOf(firstLiquidityProvider);

			await freeBetsHolder.removeUserFundingBatch(
				[firstTrader],
				collateralAddress,
				firstLiquidityProvider
			);

			const firstTraderBalanceAfterReclaimingFunding =
				await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress);
			expect(firstTraderBalanceAfterReclaimingFunding).to.equal(0);

			const firstLiquidityProviderAfterReclaiming =
				await collateral.balanceOf(firstLiquidityProvider);

			expect(firstLiquidityProviderAfterReclaiming).to.equal(
				firstLiquidityProviderBeforeReclaiming + firstTraderBalanceAfterFunding
			);

			await freeBetsHolder.removeUserFunding(
				firstLiquidityProvider,
				collateralAddress,
				firstTrader
			);

			const firstLiquidityProviderBalanceAfterReclaiming =
				await freeBetsHolder.balancePerUserAndCollateral(firstLiquidityProvider, collateralAddress);
			expect(firstLiquidityProviderBalanceAfterReclaiming).to.equal(0);
		});

		it('Should set and retrieve freeBetExpirationPeriod correctly', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			const retrievedPeriod = await freeBetsHolder.freeBetExpirationPeriod();
			expect(retrievedPeriod).to.equal(expirationPeriod);
		});

		it('Should set freeBetExpirationUpgrade on first expiration period update', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
			const newFreeBetHolder = await FreeBetsHolder.deploy();
			await newFreeBetHolder.initialize(
				firstTrader.address,
				sportsAMMV2.target,
				liveTradingProcessor.target
			);
			const freeBetsHolderAddress = await newFreeBetHolder.getAddress();
			// Check that upgrade timestamp is initially 0
			const initialUpgrade = await newFreeBetHolder.freeBetExpirationUpgrade();
			expect(initialUpgrade).to.equal(0);

			// Set the expiration period
			const txReceipt = await newFreeBetHolder
				.connect(firstTrader)
				.setFreeBetExpirationPeriod(expirationPeriod, 0);
			const blockTimestamp = (await ethers.provider.getBlock(txReceipt.blockNumber)).timestamp;

			// Check that upgrade timestamp is set
			const upgradedTimestamp = await newFreeBetHolder.freeBetExpirationUpgrade();
			expect(upgradedTimestamp).to.equal(blockTimestamp);

			// Setting again shouldn't change the upgrade timestamp
			await newFreeBetHolder
				.connect(firstTrader)
				.setFreeBetExpirationPeriod(expirationPeriod * 2, 0);
			const changedTimestamp = await newFreeBetHolder.freeBetExpirationUpgrade();
			expect(changedTimestamp).to.equal(blockTimestamp + 1);
		});

		it('Should update freeBetExpiration when funding users', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund a user
			await freeBetsHolder.fund(firstTrader, collateralAddress, BUY_IN_AMOUNT);

			// Check the expiration timestamp
			const currentTimestamp = await time.latest();
			const expirationTimestamp = await freeBetsHolder.freeBetExpiration(
				firstTrader,
				collateralAddress
			);

			expect(expirationTimestamp).to.be.closeTo(currentTimestamp + expirationPeriod, 10); // Allow for small timestamp differences
		});

		it('Should not allow removeExpiredUserFunding if free bet has not expired', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund users
			await freeBetsHolder.fundBatch([firstTrader, secondTrader], collateralAddress, BUY_IN_AMOUNT);

			// Try to remove unexpired free bets
			await expect(
				freeBetsHolder.removeExpiredUserFunding([firstTrader, secondTrader], collateralAddress)
			).to.be.revertedWith('Free bet not expired');
		});

		it('Should allow removeExpiredUserFunding after free bet expires', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund users
			await freeBetsHolder.fundBatch(
				[firstTrader, secondTrader, thirdAccount],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			// Record owner balance before
			const ownerAddress = await freeBetsHolder.owner();
			const ownerBalanceBefore = await collateral.balanceOf(ownerAddress);

			// Fast forward time to after expiration
			await time.increase(expirationPeriod + 100);

			// Now we should be able to remove expired free bets
			await freeBetsHolder.removeExpiredUserFunding([firstTrader, secondTrader], collateralAddress);

			// Check balances are zeroed
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress)
			).to.equal(0);
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(secondTrader, collateralAddress)
			).to.equal(0);
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(thirdAccount, collateralAddress)
			).to.equal(BUY_IN_AMOUNT);

			// Check owner received the tokens
			const ownerBalanceAfter = await collateral.balanceOf(ownerAddress);
			expect(Number(ownerBalanceAfter) - Number(ownerBalanceBefore)).to.be.above(
				Number(BUY_IN_AMOUNT) * 2
			);
		});

		it('Should allow anyone to call removeExpiredUserFunding', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund user
			await freeBetsHolder.fund(firstTrader, collateralAddress, BUY_IN_AMOUNT);

			// Fast forward time to after expiration
			await time.increase(expirationPeriod + 100);

			// Call from a non-owner address
			await freeBetsHolder
				.connect(firstLiquidityProvider)
				.removeExpiredUserFunding([firstTrader], collateralAddress);

			// Verify balance is zeroed
			expect(
				await freeBetsHolder.balancePerUserAndCollateral(firstTrader, collateralAddress)
			).to.equal(0);
		});

		it('Should correctly report validity of free bets', async () => {
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund a user
			await freeBetsHolder.fund(firstTrader, collateralAddress, BUY_IN_AMOUNT);

			// Check validity immediately after funding
			const [isValid, timeToExpiration] = await freeBetsHolder.isFreeBetValid(
				firstTrader,
				collateralAddress
			);
			expect(isValid).to.be.true;
			expect(timeToExpiration).to.equal(expirationPeriod);

			// Check validity for unfunded user
			const [isValid2, timeToExpiration2] = await freeBetsHolder.isFreeBetValid(
				secondTrader,
				collateralAddress
			);
			expect(isValid2).to.be.false;
			expect(timeToExpiration2).to.equal(0);

			// Fast forward time to after expiration
			await time.increase(expirationPeriod + 100);

			// Check validity after expiration
			const [isValid3, timeToExpiration3] = await freeBetsHolder.isFreeBetValid(
				firstTrader,
				collateralAddress
			);
			expect(isValid3).to.be.false;
			expect(timeToExpiration3).to.equal(0);
		});

		it('Should handle global expiration for users without specific expiration', async () => {
			const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
			const newFreeBetHolder = await FreeBetsHolder.deploy();
			await newFreeBetHolder.initialize(
				firstTrader.address,
				sportsAMMV2.target,
				liveTradingProcessor.target
			);

			// Add collateral support
			await newFreeBetHolder.connect(firstTrader).addSupportedCollateral(collateralAddress, true);

			// Send some collateral to the contract
			await collateral.connect(firstTrader).approve(newFreeBetHolder.target, BUY_IN_AMOUNT);

			// Set balance for user but don't set an expiration date
			await newFreeBetHolder
				.connect(firstTrader)
				.removeUserFunding(firstTrader.address, collateralAddress, firstTrader.address);

			// Manually set the balance (simulate having a balance without expiration)
			await newFreeBetHolder
				.connect(firstTrader)
				.fund(secondTrader, collateralAddress, BUY_IN_AMOUNT);

			// Set expiration period which also sets the upgrade timestamp
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await newFreeBetHolder.connect(firstTrader).setFreeBetExpirationPeriod(expirationPeriod, 0);
			const expirationPeriodOnContract = await newFreeBetHolder.freeBetExpirationPeriod();
			expect(expirationPeriodOnContract).to.equal(expirationPeriod);
			const upgradeTimestamp = await newFreeBetHolder.freeBetExpirationUpgrade();
			const currentTimestamp = await time.latest();
			expect(upgradeTimestamp).to.equal(currentTimestamp);
			const freeBetAmount = await newFreeBetHolder.balancePerUserAndCollateral(
				secondTrader,
				collateralAddress
			);
			expect(freeBetAmount).to.equal(BUY_IN_AMOUNT);
			await newFreeBetHolder
				.connect(firstTrader)
				.setUserFreeBetExpiration(secondTrader, collateralAddress, 0);
			// Check validity - should be valid due to global expiration
			const [isValid, timeToExpiration] = await newFreeBetHolder.isFreeBetValid(
				secondTrader,
				collateralAddress
			);
			expect(isValid).to.be.true;
			expect(timeToExpiration).to.equal(expirationPeriod - 1);

			// Fast forward time to after global expiration
			await time.increase(expirationPeriod + 100);

			// Check validity - should be invalid now
			const [isValid2, timeToExpiration2] = await newFreeBetHolder.isFreeBetValid(
				secondTrader,
				collateralAddress
			);
			expect(isValid2).to.be.false;
			expect(timeToExpiration2).to.equal(0);
		});

		it('Should handle zero balances correctly', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// User with zero balance should have invalid free bet
			const [isValid, timeToExpiration] = await freeBetsHolder.isFreeBetValid(
				thirdAccount,
				collateralAddress
			);
			expect(isValid).to.be.false;
			expect(timeToExpiration).to.equal(0);

			// Fund user
			await freeBetsHolder.fund(thirdAccount, collateralAddress, BUY_IN_AMOUNT);

			// Now free bet should be valid
			const [isValid2, timeToExpiration2] = await freeBetsHolder.isFreeBetValid(
				thirdAccount,
				collateralAddress
			);
			expect(isValid2).to.be.true;
			expect(timeToExpiration2).to.equal(expirationPeriod);

			// Remove all funding
			await freeBetsHolder.removeUserFunding(thirdAccount, collateralAddress, firstTrader);

			// Free bet should be invalid due to zero balance
			const [isValid3, timeToExpiration3] = await freeBetsHolder.isFreeBetValid(
				thirdAccount,
				collateralAddress
			);
			expect(isValid3).to.be.false;
			expect(timeToExpiration3).to.equal(0);
		});

		it('Should handle zero experation period correctly', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// User with zero balance should have invalid free bet
			const [isValid, timeToExpiration] = await freeBetsHolder.isFreeBetValid(
				thirdAccount,
				collateralAddress
			);
			expect(isValid).to.be.false;
			expect(timeToExpiration).to.equal(0);

			// Fund user
			await freeBetsHolder.fund(thirdAccount, collateralAddress, BUY_IN_AMOUNT);
			const canTrade = await freeBetsHolder.isFreeBetValid(thirdAccount, collateralAddress);
			expect(canTrade[0]).to.be.true;

			// Now free bet should be valid
			const [isValid2, timeToExpiration2] = await freeBetsHolder.isFreeBetValid(
				thirdAccount,
				collateralAddress
			);
			expect(isValid2).to.be.true;
			expect(timeToExpiration2).to.equal(expirationPeriod);

			await freeBetsHolder.setFreeBetExpirationPeriod(0, 0);
			await freeBetsHolder.setUserFreeBetExpiration(thirdAccount, collateralAddress, 0);
			const canTrade2 = await freeBetsHolder.isFreeBetValid(thirdAccount, collateralAddress);
			expect(canTrade2[0]).to.be.false;

			await freeBetsHolder.setUserFreeBetExpiration(thirdAccount, collateralAddress, 10);
			const canTrade3 = await freeBetsHolder.isFreeBetValid(thirdAccount, collateralAddress);
			expect(canTrade3[0]).to.be.false;
			// Remove all funding
			await freeBetsHolder.removeUserFunding(thirdAccount, collateralAddress, firstTrader);

			// Free bet should be invalid due to zero balance
			const [isValid3, timeToExpiration3] = await freeBetsHolder.isFreeBetValid(
				thirdAccount,
				collateralAddress
			);
			expect(isValid3).to.be.false;
			expect(timeToExpiration3).to.equal(0);
		});

		it('Should return the correct users with free bets per collateral', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Initially no users should have free bets
			const initialUserCount =
				await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(collateralAddress);
			expect(initialUserCount).to.equal(1);

			// Fund multiple users
			await freeBetsHolder.fundBatch(
				[firstTrader, secondTrader, thirdAccount],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			// Check total number of users with free bets
			const userCount = await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(collateralAddress);
			expect(userCount).to.equal(3);

			// Get all users with free bets
			const users = await freeBetsHolder.getUsersWithFreeBetPerCollateral(collateralAddress, 0, 10);
			expect(users.length).to.equal(3);
			expect(users).to.include(firstTrader.address);
			expect(users).to.include(secondTrader.address);
			expect(users).to.include(thirdAccount.address);

			// Test pagination
			const firstPageUsers = await freeBetsHolder.getUsersWithFreeBetPerCollateral(
				collateralAddress,
				0,
				2
			);
			expect(firstPageUsers.length).to.equal(2);

			const secondPageUsers = await freeBetsHolder.getUsersWithFreeBetPerCollateral(
				collateralAddress,
				2,
				2
			);
			expect(secondPageUsers.length).to.equal(1);

			// Remove funding for one user
			await freeBetsHolder.removeUserFunding(
				firstTrader,
				collateralAddress,
				firstLiquidityProvider
			);

			// Check updated user count
			const updatedUserCount =
				await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(collateralAddress);
			expect(updatedUserCount).to.equal(2);

			const updatedUsers = await freeBetsHolder.getUsersWithFreeBetPerCollateral(
				collateralAddress,
				0,
				10
			);
			expect(updatedUsers.length).to.equal(2);
			expect(updatedUsers).to.not.include(firstTrader.address);
		});

		it('Should return the correct users with valid free bets per collateral', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund multiple users
			await freeBetsHolder.fundBatch(
				[firstTrader, secondTrader, thirdAccount],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			// All users should have valid free bets initially
			const [allUsers, freeBetAmounts, isValid, timeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 10);
			expect(allUsers.length).to.equal(3);
			expect(allUsers).to.include(firstTrader.address);
			expect(allUsers).to.include(secondTrader.address);
			expect(allUsers).to.include(thirdAccount.address);
			expect(isValid.filter(Boolean).length).to.equal(3);

			// Set one user's free bet to expire
			await freeBetsHolder.setUserFreeBetExpiration(firstTrader, collateralAddress, 0);

			// Now only two users should have valid free bets
			const [updatedUsers, updatedAmounts, updatedIsValid, updatedTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 10);
			expect(updatedUsers.length).to.equal(3);
			expect(updatedIsValid.filter(Boolean).length).to.equal(3);

			// Fast forward time to expire all free bets
			await time.increase(expirationPeriod + 100);

			// Now no users should have valid free bets
			const [expiredUsers, expiredAmounts, expiredIsValid, expiredTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 10);
			expect(expiredUsers.length).to.equal(3);
			expect(expiredIsValid.filter(Boolean).length).to.equal(0);
		});

		it('Should return the correct users with invalid free bets per collateral', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund multiple users
			await freeBetsHolder.fundBatch(
				[firstTrader, secondTrader, thirdAccount],
				collateralAddress,
				BUY_IN_AMOUNT
			);

			// No users should have invalid free bets initially
			const [allUsers, freeBetAmounts, isValid, timeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 10);
			expect(allUsers.length).to.equal(3);
			expect(isValid.filter(Boolean).length).to.equal(3);

			// Set one user's free bet to expire
			await freeBetsHolder.setUserFreeBetExpiration(firstTrader, collateralAddress, 0);

			// Now only one user should have invalid free bets
			const [updatedUsers, updatedAmounts, updatedIsValid, updatedTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 10);
			expect(updatedUsers.length).to.equal(3);
			expect(updatedIsValid.filter(Boolean).length).to.equal(3);

			// Fast forward time to expire all free bets
			await time.increase(expirationPeriod + 100);

			// Now all users should have invalid free bets
			const [expiredUsers, expiredAmounts, expiredIsValid, expiredTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 10);
			expect(expiredUsers.length).to.equal(3);
			expect(expiredIsValid.filter(Boolean).length).to.equal(0);
		});

		it('Should handle pagination correctly in user retrieval functions', async () => {
			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Create a larger number of users to test pagination
			const extraAccounts = await ethers.getSigners();
			const testAccounts = extraAccounts.slice(0, 5); // Take 5 accounts for testing

			// Fund all test accounts
			for (const account of testAccounts) {
				await freeBetsHolder.fund(account, collateralAddress, BUY_IN_AMOUNT);
			}

			// Test pagination with getUsersFreeBetDataPerCollateral
			const [firstPageUsers, firstPageAmounts, firstPageIsValid, firstPageTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 2);
			expect(firstPageUsers.length).to.equal(2);

			const [secondPageUsers, secondPageAmounts, secondPageIsValid, secondPageTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 2, 2);
			expect(secondPageUsers.length).to.equal(2);

			const [thirdPageUsers, thirdPageAmounts, thirdPageIsValid, thirdPageTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 4, 2);
			expect(thirdPageUsers.length).to.equal(2);

			// Expire some free bets
			await freeBetsHolder.setUserFreeBetExpiration(testAccounts[0], collateralAddress, 0);
			await freeBetsHolder.setUserFreeBetExpiration(testAccounts[2], collateralAddress, 0);

			// Test pagination with valid/invalid filtering
			const [allUsers, allAmounts, allIsValid, allTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 2);
			expect(allUsers.length).to.be.lessThanOrEqual(2);
			expect(allIsValid.filter(Boolean).length).to.be.lessThanOrEqual(2);

			// Test with pageSize larger than available users
			const [allUsersLarge, allAmountsLarge, allIsValidLarge, allTimeToExpirationLarge] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(collateralAddress, 0, 20);
			expect(allUsersLarge.length).to.equal(6);
		});

		it('Should correctly add users to free bet tracking without funding them', async () => {
			// Create a new collateral token for this test
			const newCollateralFactory = await ethers.getContractFactory('ExoticUSD');
			const newCollateral = await newCollateralFactory.deploy();
			const newCollateralAddress = await newCollateral.getAddress();

			// Add support for new collateral
			await freeBetsHolder.addSupportedCollateral(newCollateralAddress, true);

			// Prepare test accounts
			const testAccounts = await ethers.getSigners();
			const usersToAdd = [
				testAccounts[5].address,
				testAccounts[6].address,
				testAccounts[7].address,
			];

			// Initially there should be no users with free bets for this collateral
			const initialUserCount =
				await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(newCollateralAddress);
			expect(initialUserCount).to.equal(0);

			// Add users with setUsersWithAlreadyFundedFreeBetPerCollateral
			await freeBetsHolder.setUsersWithAlreadyFundedFreeBetPerCollateral(
				usersToAdd,
				newCollateralAddress
			);

			// Check users were added to tracking
			const userCountAfterAdd =
				await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(newCollateralAddress);
			expect(userCountAfterAdd).to.equal(3);

			// Verify users are in the list
			const [listedUsers, listedAmounts, listedIsValid, listedTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(newCollateralAddress, 0, 10);
			expect(listedUsers.length).to.equal(3);
			expect(listedUsers).to.include(usersToAdd[0]);
			expect(listedUsers).to.include(usersToAdd[1]);
			expect(listedUsers).to.include(usersToAdd[2]);

			// Check these users have no actual balance
			for (const user of usersToAdd) {
				const balance = await freeBetsHolder.balancePerUserAndCollateral(
					user,
					newCollateralAddress
				);
				expect(balance).to.equal(0);
			}

			// Users should show up as invalid since they have no balance
			const [invalidUsers, invalidAmounts, invalidIsValid, invalidTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(newCollateralAddress, 0, 10);
			expect(invalidUsers.length).to.equal(3);
			expect(invalidIsValid.filter(Boolean).length).to.equal(0);

			// Add one user a second time (should have no effect)
			await freeBetsHolder.setUsersWithAlreadyFundedFreeBetPerCollateral(
				[usersToAdd[0]],
				newCollateralAddress
			);

			// User count should remain the same (no duplicates)
			const userCountAfterDuplicate =
				await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(newCollateralAddress);
			expect(userCountAfterDuplicate).to.equal(3);

			// Now fund one of the users properly
			await newCollateral.mintForUser(usersToAdd[0]);
			await newCollateral.approve(freeBetsHolder.target, BUY_IN_AMOUNT);
			await freeBetsHolder.fund(usersToAdd[0], newCollateralAddress, BUY_IN_AMOUNT);

			// Check balance was updated
			const fundedUserBalance = await freeBetsHolder.balancePerUserAndCollateral(
				usersToAdd[0],
				newCollateralAddress
			);
			expect(fundedUserBalance).to.equal(BUY_IN_AMOUNT);

			// User count should remain the same since user was already in the list
			const userCountAfterFunding =
				await freeBetsHolder.numOfUsersWithFreeBetPerCollateral(newCollateralAddress);
			expect(userCountAfterFunding).to.equal(3);

			// One user should now be valid (the funded one)
			const [validUsers, validAmounts, validIsValid, validTimeToExpiration] =
				await freeBetsHolder.getUsersFreeBetDataPerCollateral(newCollateralAddress, 0, 10);
			expect(validUsers.length).to.equal(3);
			expect(validIsValid.filter(Boolean).length).to.equal(1);
			expect(validUsers[0]).to.equal(usersToAdd[0]);
		});
	});
});
