const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	RESULT_TYPE,
	GAME_ID_1,
	GAME_ID_2,
	GAME_ID_3,
	GAME_ID_4,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const {
	SPORTS_AMM_INITAL_PARAMS,
	RISK_MANAGER_INITAL_PARAMS,
} = require('../../../constants/overtimeContractParams');

describe('SportsAMMV2Data Read Data', () => {
	let sportsAMMV2Data,
		sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		tradeDataTenMarketsCurrentRound,
		firstTrader,
		firstLiquidityProvider,
		ticketAddress,
		numberOfGamesOnTicket,
		freeBetsHolder,
		collateralAddress,
		secondTrader;

	beforeEach(async () => {
		({
			sportsAMMV2Data,
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			tradeDataTenMarketsCurrentRound,
			collateralAddress,
			freeBetsHolder,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader, secondTrader, firstLiquidityProvider } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		const quote = await sportsAMMV2.tradeQuote(
			tradeDataTenMarketsCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		ticketAddress = activeTickets[0];
		numberOfGamesOnTicket = tradeDataTenMarketsCurrentRound.length;
	});

	describe('Sports AMM data', () => {
		it('Should return Sports AMM parameters', async () => {
			const params = await sportsAMMV2Data.getSportsAMMParameters();

			expect(params.minBuyInAmount).to.be.equal(RISK_MANAGER_INITAL_PARAMS.minBuyInAmount);
			expect(params.maxTicketSize).to.be.equal(RISK_MANAGER_INITAL_PARAMS.maxTicketSize);
			expect(params.maxSupportedAmount).to.be.equal(RISK_MANAGER_INITAL_PARAMS.maxSupportedAmount);
			expect(params.maxSupportedOdds).to.be.equal(RISK_MANAGER_INITAL_PARAMS.maxSupportedOdds);
			expect(params.safeBoxFee).to.be.equal(SPORTS_AMM_INITAL_PARAMS.safeBoxFee);
		});
	});

	describe('Sports AMM Manager Data', () => {
		it('Should read ticket data active/resolved from SportsAMMV2Manager', async () => {
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];
			expect(await sportsAMMV2Manager.isActiveTicket(ticketAddress)).to.be.equal(true);
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.be.equal(1);
			const activeTicketsForUser = await sportsAMMV2Manager.getActiveTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(activeTicketsForUser[0]).to.be.equal(ticketAddress);
			expect(await sportsAMMV2Manager.numOfActiveTicketsPerUser(firstTrader)).to.be.equal(1);

			const resolvedTicketsForUser = await sportsAMMV2Manager.getResolvedTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(resolvedTicketsForUser.length).to.be.equal(0);
			expect(await sportsAMMV2Manager.numOfResolvedTicketsPerUser(firstTrader)).to.be.equal(0);

			const firstGameId = tradeDataTenMarketsCurrentRound[0].gameId;
			const ticketsPerGame = await sportsAMMV2Manager.getTicketsPerGame(0, 100, firstGameId);
			expect(ticketsPerGame[0]).to.be.equal(ticketAddress);
			expect(await sportsAMMV2Manager.numOfTicketsPerGame(firstGameId)).to.be.equal(1);
		});
	});

	describe('Tickets data', () => {
		it('Should return unresolved games data', async () => {
			let result = await sportsAMMV2Data.getOnlyActiveGameIdsAndTicketsOf(
				[GAME_ID_1, GAME_ID_2, GAME_ID_3, GAME_ID_4],
				0,
				4
			);
			expect(result[0][0]).to.be.equal(GAME_ID_3);
			expect(result[0][1]).to.be.equal(GAME_ID_4);
			expect(result[1][0].toString()).to.be.equal('1');
			expect(result[1][1].toString()).to.be.equal('1');
			expect(result[2][0][0]).to.be.equal(ticketAddress);
			expect(result[2][1][0]).to.be.equal(ticketAddress);
		});
		it('Should return gameIds, typeIds, playerIds and lines', async () => {
			let result = await sportsAMMV2Data.getAllActiveGameIdsTypeIdsPlayerIdsLinesForGameIds(
				[GAME_ID_1, GAME_ID_2, GAME_ID_3, GAME_ID_4],
				0,
				4
			);
			expect(result.length).to.be.equal(tradeDataTenMarketsCurrentRound.length);
			let tradeGameIds = Array.from(tradeDataTenMarketsCurrentRound.entries()).map(
				(tradeData) => tradeData[1].gameId
			);
			for (let i = 0; i < result.length; i++) {
				expect(result[i][0]).to.be.equal(tradeGameIds[i]);
			}
		});
		it('Should return tickets data', async () => {
			const ticketsData = await sportsAMMV2Data.getTicketsData([ticketAddress]);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
		});

		it('Should return active tickets data per user with free bets', async () => {
			const firstTraderAddress = await firstTrader.getAddress();
			const [ticketsData, freeBetsData] = await sportsAMMV2Data.getActiveTicketsDataPerUser(
				firstTrader,
				0,
				100
			);

			expect(freeBetsData.length).to.be.equal(0);
			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
			expect(ticketsData[0].ticketOwner).to.be.equal(firstTraderAddress);
		});
		it('Should return active tickets data per user', async () => {
			const firstTraderAddress = await firstTrader.getAddress();
			const [ticketsData] = await sportsAMMV2Data.getActiveTicketsDataPerUser(firstTrader, 0, 100);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
			expect(ticketsData[0].ticketOwner).to.be.equal(firstTraderAddress);
		});

		it('Should return resolved tickets data per user', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
			// resolve as losing for user
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[0].gameId],
				[tradeDataTenMarketsCurrentRound[0].typeId],
				[tradeDataTenMarketsCurrentRound[0].playerId],
				[[1]]
			);
			await sportsAMMV2.exerciseTicket(ticketAddress);

			const firstTraderAddress = await firstTrader.getAddress();
			const [ticketsData, ,] = await sportsAMMV2Data.getResolvedTicketsDataPerUser(
				firstTrader,
				0,
				100
			);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(true);
			expect(ticketsData[0].isLost).to.be.equal(true);
			expect(ticketsData[0].isUserTheWinner).to.be.equal(false);
			expect(ticketsData[0].ticketOwner).to.be.equal(firstTraderAddress);
		});

		it('Should return tickets data per game', async () => {
			const firstGameId = tradeDataTenMarketsCurrentRound[0].gameId;

			const ticketsData = await sportsAMMV2Data.getTicketsDataPerGame(firstGameId, 0, 100);

			expect(ticketsData.length).to.be.equal(1);
			expect(ticketsData[0].id).to.be.equal(ticketAddress);
			expect(ticketsData[0].marketsData.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].marketsResult.length).to.be.equal(numberOfGamesOnTicket);
			expect(ticketsData[0].resolved).to.be.equal(false);
			expect(ticketsData[0].marketsData[0].gameId).to.be.equal(firstGameId);
		});

		it('Should return free bets data per user', async () => {
			// Ensure the user has no free bets initially
			const initialBalance = await freeBetsHolder.balancePerUserAndCollateral(
				secondTrader,
				collateralAddress
			);
			expect(initialBalance).to.equal(0);

			// Set expiration period
			const expirationPeriod = 7 * 24 * 60 * 60; // 7 days
			await freeBetsHolder.setFreeBetExpirationPeriod(expirationPeriod, 0);

			// Fund user with free bets
			const fundAmount = ethers.parseEther('10');
			await freeBetsHolder.fund(secondTrader, collateralAddress, fundAmount);

			// Check the balance was updated
			const balanceAfterFunding = await freeBetsHolder.balancePerUserAndCollateral(
				secondTrader,
				collateralAddress
			);
			expect(balanceAfterFunding).to.equal(fundAmount);

			// Get free bets data via SportsAMMV2Data
			const [freeBetsAmountPerCollateral, freeBetsExpiryPerCollateral] =
				await sportsAMMV2Data.getFreeBetsDataPerUser(secondTrader, [collateralAddress]);

			// Verify the data is correct
			expect(freeBetsAmountPerCollateral.length).to.equal(1);
			expect(freeBetsExpiryPerCollateral.length).to.equal(1);
			expect(freeBetsAmountPerCollateral[0]).to.equal(fundAmount);
			

			// Expiry should be approximately the expiration period (allowing for slight timestamp differences)
			expect(freeBetsExpiryPerCollateral[0]).to.be.closeTo(expirationPeriod, 10);

			// Test with multiple collaterals by adding a mock collateral
			const MockERC20 = await ethers.getContractFactory('ExoticUSD');
			const secondCollateral = await MockERC20.deploy();
			await secondCollateral.mintForUser(secondTrader);
			const secondCollateralAddress = await secondCollateral.getAddress();

			// Add support for second collateral
			await freeBetsHolder.addSupportedCollateral(secondCollateralAddress, true);

			// User should have zero balance for the second collateral initially
			const secondCollateralInitialBalance = await freeBetsHolder.balancePerUserAndCollateral(
				secondTrader,
				secondCollateralAddress
			);
			expect(secondCollateralInitialBalance).to.equal(0);

			// Get data for both collaterals
			const [amountsForBothCollaterals, expiriesForBothCollaterals] =
				await sportsAMMV2Data.getFreeBetsDataPerUser(secondTrader, [
					collateralAddress,
					secondCollateralAddress,
				]);

			// Verify data for both collaterals
			expect(amountsForBothCollaterals.length).to.equal(2);
			expect(expiriesForBothCollaterals.length).to.equal(2);
			expect(amountsForBothCollaterals[0]).to.equal(fundAmount);
			expect(amountsForBothCollaterals[1]).to.equal(0);
			expect(expiriesForBothCollaterals[0]).to.be.closeTo(expirationPeriod, 10);
			expect(expiriesForBothCollaterals[1]).to.be.closeTo(expirationPeriod, 10); // Should use global expiration

			await freeBetsHolder.setFreeBetExpirationPeriod(0, 0);
			await freeBetsHolder.setUserFreeBetExpiration(secondTrader, collateralAddress, 0);
			const [amountsForBothCollaterals2, expiriesForBothCollaterals2] =
				await sportsAMMV2Data.getFreeBetsDataPerUser(secondTrader, [
					collateralAddress,
					secondCollateralAddress,
				]);
			expect(amountsForBothCollaterals2.length).to.equal(2);
			expect(expiriesForBothCollaterals2.length).to.equal(2);
			expect(amountsForBothCollaterals2[0]).to.equal(fundAmount);
			expect(amountsForBothCollaterals2[1]).to.equal(0);
			expect(expiriesForBothCollaterals2[0]).to.equal(0);
			expect(expiriesForBothCollaterals2[1]).to.equal(0);
		});
	});

	describe('Risk Manager data', () => {
		it('Should return spent amounts for multiple games', async () => {
			// Get first two gameIds from the trade data
			const gameIds = [
				tradeDataTenMarketsCurrentRound[0].gameId,
				tradeDataTenMarketsCurrentRound[1].gameId,
			];

			const spentAmounts = await sportsAMMV2Data.getSpentOnGames(gameIds);

			// Since we made trades on these games, spent amounts should be non-zero
			expect(spentAmounts.length).to.equal(2);
			expect(spentAmounts[0]).to.be.gt(0);
			expect(spentAmounts[1]).to.be.gt(0);
		});

		it('Should return spent and risk amounts for multiple markets', async () => {
			// Get first two gameIds from the trade data
			const gameIds = [
				tradeDataTenMarketsCurrentRound[0].gameId,
				tradeDataTenMarketsCurrentRound[1].gameId,
			];
			const typeIds = [
				tradeDataTenMarketsCurrentRound[0].typeId,
				tradeDataTenMarketsCurrentRound[1].typeId,
			];
			const playerIds = [
				tradeDataTenMarketsCurrentRound[0].playerId,
				tradeDataTenMarketsCurrentRound[1].playerId,
			];
			const positions = [0, 0];

			const sportIds = [4, 4];

			const maturities = [
				tradeDataTenMarketsCurrentRound[0].maturity,
				tradeDataTenMarketsCurrentRound[1].maturity,
			];

			const riskAmounts = await sportsAMMV2Data.getRiskOnMarkets(
				gameIds,
				typeIds,
				playerIds,
				positions
			);

			console.log('riskAmounts: ' + riskAmounts);

			const capAmounts = await sportsAMMV2Data.getCapsPerMarkets(
				gameIds,
				sportIds,
				typeIds,
				maturities
			);

			console.log('capAmounts: ' + capAmounts);

			// Since we made trades on these games, riskAmounts should be non-zero
			expect(riskAmounts.length).to.equal(2);
			expect(riskAmounts[0]).to.be.gt(0);
			expect(riskAmounts[1]).to.be.gt(0);

			// Since we made trades on these games, capAmounts should be non-zero
			expect(capAmounts.length).to.equal(2);
			expect(capAmounts[0]).to.be.gt(0);
			expect(capAmounts[1]).to.be.gt(0);
		});
	});
});
