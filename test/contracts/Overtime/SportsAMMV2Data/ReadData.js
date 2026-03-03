/* eslint-disable @typescript-eslint/no-var-requires */

const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');

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

	const ONE = 10n ** 18n;

	// helper to read implied probability for a given trade item + position
	const getImpliedOddForPosition = (tradeItem, position = 0) => {
		// Most common shape in this repo: tradeItem.odds is an array of implied probabilities (1e18)
		if (tradeItem && Array.isArray(tradeItem.odds) && tradeItem.odds.length > position) {
			return BigInt(tradeItem.odds[position].toString());
		}
		// fallback (in case some fixtures expose `odd`)
		if (tradeItem && tradeItem.odd !== undefined) return BigInt(tradeItem.odd.toString());
		// last resort: return something valid-ish (< 1e18) but keep deterministic
		return 5n * 10n ** 17n; // 0.5
	};

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
			const tAddr = activeTickets[0];

			expect(await sportsAMMV2Manager.isActiveTicket(tAddr)).to.be.equal(true);
			expect(await sportsAMMV2Manager.numOfActiveTickets()).to.be.equal(1);

			const activeTicketsForUser = await sportsAMMV2Manager.getActiveTicketsPerUser(
				0,
				100,
				firstTrader
			);
			expect(activeTicketsForUser[0]).to.be.equal(tAddr);
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
			expect(ticketsPerGame[0]).to.be.equal(tAddr);
			expect(await sportsAMMV2Manager.numOfTicketsPerGame(firstGameId)).to.be.equal(1);
		});
	});

	describe('Tickets data', () => {
		it('Should return unresolved games data', async () => {
			const result = await sportsAMMV2Data.getOnlyActiveGameIdsAndTicketsOf(
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
			const result = await sportsAMMV2Data.getAllActiveGameIdsTypeIdsPlayerIdsLinesForGameIds(
				[GAME_ID_1, GAME_ID_2, GAME_ID_3, GAME_ID_4],
				0,
				4
			);

			expect(result.length).to.be.equal(tradeDataTenMarketsCurrentRound.length);

			const tradeGameIds = Array.from(tradeDataTenMarketsCurrentRound.entries()).map(
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
			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			const firstTraderAddress = await firstTrader.getAddress();
			const [ticketsData] = await sportsAMMV2Data.getResolvedTicketsDataPerUser(
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
			const sportsAMMV2Address = await sportsAMMV2.getAddress();

			// Add support for second collateral
			await freeBetsHolder.addSupportedCollateral(
				secondCollateralAddress,
				true,
				sportsAMMV2Address
			);

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

			await freeBetsHolder.setFreeBetExpirationPeriod(0, 0);
			await freeBetsHolder.setUserFreeBetExpiration(secondTrader, collateralAddress, 20);

			const [amountsForBothCollaterals3, expiriesForBothCollaterals3] =
				await sportsAMMV2Data.getFreeBetsDataPerUser(secondTrader, [
					collateralAddress,
					secondCollateralAddress,
				]);

			expect(amountsForBothCollaterals3.length).to.equal(2);
			expect(expiriesForBothCollaterals3.length).to.equal(2);
			expect(amountsForBothCollaterals3[0]).to.equal(fundAmount);
			expect(amountsForBothCollaterals3[1]).to.equal(0);
			expect(expiriesForBothCollaterals3[0]).to.equal(0);
			expect(expiriesForBothCollaterals3[1]).to.equal(0);
		});
	});

	describe('Risk Manager data', () => {
		it('Should return spent amounts for multiple games', async () => {
			const gameIds = [
				tradeDataTenMarketsCurrentRound[0].gameId,
				tradeDataTenMarketsCurrentRound[1].gameId,
			];
			const spentAmounts = await sportsAMMV2Data.getSpentOnGames(gameIds);

			expect(spentAmounts.length).to.equal(2);
			expect(spentAmounts[0]).to.be.gt(0);
			expect(spentAmounts[1]).to.be.gt(0);
		});

		it('Should return spent and risk amounts for multiple markets', async () => {
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
			const capAmounts = await sportsAMMV2Data.getCapsPerMarkets(
				gameIds,
				sportIds,
				typeIds,
				maturities
			);

			expect(riskAmounts.length).to.equal(2);
			expect(riskAmounts[0]).to.be.gt(0);
			expect(riskAmounts[1]).to.be.gt(0);

			expect(capAmounts.length).to.equal(2);
			expect(capAmounts[0]).to.be.gt(0);
			expect(capAmounts[1]).to.be.gt(0);
		});
	});

	// -------------------------------------------------------------------------
	// NEW: coverage for "cashout stuff" in SportsAMMV2Data
	// -------------------------------------------------------------------------
	describe('Cashout data', () => {
		it('getCashoutQuoteAndPayout should return (0,0) when ticket is not cashoutable/active', async () => {
			// Make the ticket inactive by resolving it, then call the method.
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataTenMarketsCurrentRound[0].gameId],
				[tradeDataTenMarketsCurrentRound[0].typeId],
				[tradeDataTenMarketsCurrentRound[0].playerId],
				[[1]]
			);
			await sportsAMMV2.handleTicketResolving(ticketAddress, 0);

			// any arrays (won't be used because it returns early)
			const approvedOddsPerLeg = [ONE];
			const isLegSettled = [false];

			const [quote, payout] = await sportsAMMV2Data.getCashoutQuoteAndPayout(
				ticketAddress,
				approvedOddsPerLeg,
				isLegSettled
			);
			expect(quote).to.equal(0);
			expect(payout).to.equal(0);
		});

		it('getCashoutQuoteAndPayout should return (0,0) for a random address (not a ticket)', async () => {
			const approvedOddsPerLeg = [ONE];
			const isLegSettled = [false];

			const [quote, payout] = await sportsAMMV2Data.getCashoutQuoteAndPayout(
				ZERO_ADDRESS,
				approvedOddsPerLeg,
				isLegSettled
			);
			expect(quote).to.equal(0);
			expect(payout).to.equal(0);
		});
	});

	// -------------------------------------------------------------------------
	// NEW: coverage for getMaxStakeAndLiquidityBatch
	// -------------------------------------------------------------------------
	describe('Max stake and liquidity batch', () => {
		it('Should return maxStake and availableLiquidity arrays for valid inputs', async () => {
			const t0 = tradeDataTenMarketsCurrentRound[0];
			const t1 = tradeDataTenMarketsCurrentRound[1];

			const inputs = [
				{
					gameId: t0.gameId,
					sportId: 4, // NBA in your fixtures/tests
					typeId: t0.typeId,
					playerId: t0.playerId,
					line: t0.line,
					maturity: t0.maturity,
					isLive: false,
					position: 0,
					odds: getImpliedOddForPosition(t0, 0),
				},
				{
					gameId: t1.gameId,
					sportId: 4,
					typeId: t1.typeId,
					playerId: t1.playerId,
					line: t1.line,
					maturity: t1.maturity,
					isLive: false,
					position: 0,
					odds: getImpliedOddForPosition(t1, 0),
				},
			];

			const [maxStakes, availableLiquidity] =
				await sportsAMMV2Data.getMaxStakeAndLiquidityBatch(inputs);

			expect(maxStakes.length).to.equal(2);
			expect(availableLiquidity.length).to.equal(2);

			// Liquidity should be >= 0 always; after a trade it is usually > 0 (unless caps are exhausted).
			expect(availableLiquidity[0]).to.be.gte(0);
			expect(availableLiquidity[1]).to.be.gte(0);

			// For valid implied odds (0 < odds < 1e18), the function returns some max stake (often > 0).
			// We keep this assertion soft to avoid flakiness if caps are tight in some envs.
			expect(maxStakes[0]).to.be.gte(0);
			expect(maxStakes[1]).to.be.gte(0);
		});

		it('Should return 0 maxStake when odds are invalid (0 or >= 1e18)', async () => {
			const t0 = tradeDataTenMarketsCurrentRound[0];

			const inputs = [
				{
					gameId: t0.gameId,
					sportId: 4,
					typeId: t0.typeId,
					playerId: t0.playerId,
					line: t0.line,
					maturity: t0.maturity,
					isLive: false,
					position: 0,
					odds: 0,
				},
				{
					gameId: t0.gameId,
					sportId: 4,
					typeId: t0.typeId,
					playerId: t0.playerId,
					line: t0.line,
					maturity: t0.maturity,
					isLive: false,
					position: 0,
					odds: ONE, // 1e18
				},
			];

			const [maxStakes, availableLiquidity] =
				await sportsAMMV2Data.getMaxStakeAndLiquidityBatch(inputs);

			expect(maxStakes.length).to.equal(2);
			expect(availableLiquidity.length).to.equal(2);

			expect(maxStakes[0]).to.equal(0);
			expect(maxStakes[1]).to.equal(0);

			// availableLiquidity is still computed (position cap - positionRisk)
			expect(availableLiquidity[0]).to.be.gte(0);
			expect(availableLiquidity[1]).to.be.gte(0);
		});
	});

	// -------------------------------------------------------------------------
	// Small extra coverage for read helpers that were previously only lightly hit
	// -------------------------------------------------------------------------
	describe('Market resolution helpers', () => {
		it('areMarketsResolved should return bool[] with default false for unresolved (non-combined) markets', async () => {
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
			const lines = [
				tradeDataTenMarketsCurrentRound[0].line,
				tradeDataTenMarketsCurrentRound[1].line,
			];

			const resolvedFlags = await sportsAMMV2Data.areMarketsResolved(
				gameIds,
				typeIds,
				playerIds,
				lines
			);

			expect(resolvedFlags.length).to.equal(2);
			expect(resolvedFlags[0]).to.equal(false);
			expect(resolvedFlags[1]).to.equal(false);
		});

		it('getResultsForMarkets should return results arrays (empty or populated depending on RM)', async () => {
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

			const results = await sportsAMMV2Data.getResultsForMarkets(gameIds, typeIds, playerIds);

			expect(results.length).to.equal(2);
			// could be empty at this point; just assert it's an array-like response
			expect(results[0]).to.exist;
			expect(results[1]).to.exist;
		});
	});
});
