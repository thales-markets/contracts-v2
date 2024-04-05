const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	TYPE_ID_TOTAL,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
	GAME_ID_1,
	WINNER_TOTAL_COMBINED_POSTIONS,
	MARKET_POSITION_STATUS,
	TOTAL_LINE,
	UNDER_TOTAL_LINE,
	TYPE_ID_SPREAD,
	UNDER_SPREAD_LINE,
	SPREAD_LINE,
} = require('../../../constants/overtime');

describe('SportsAMMV2ResultManager Results Check', () => {
	let sportsAMMV2ResultManager, secondAccount;

	beforeEach(async () => {
		({ sportsAMMV2ResultManager } = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Resolve check', () => {
		it('Should return market as resolved (single positions)', async () => {
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
				false
			);

			await sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]]);

			// check resolve game 1
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
				false
			);
		});

		it('Should return market as resolved (combined positions)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.isMarketResolved(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(false);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1, GAME_ID_1],
				[0, TYPE_ID_TOTAL],
				[0, 0],
				[[1], [UNDER_TOTAL_LINE]]
			);

			// check resolve game 1
			expect(
				await sportsAMMV2ResultManager.isMarketResolved(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isMarketCancelled(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(false);
		});
	});

	describe('Cancel check', () => {
		it('Should return market as cancelled (single positions)', async () => {
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
				false
			);

			await sportsAMMV2ResultManager.cancelMarkets([GAME_ID_1], [0], [0], [0]);

			// check cancel game 1
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
		});

		it('Should return market as cancelled (combined positions)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.isMarketCancelled(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(false);

			await sportsAMMV2ResultManager.cancelGames([GAME_ID_1]);

			// check cancel game 1
			expect(
				await sportsAMMV2ResultManager.isMarketResolved(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isMarketCancelled(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(true);
		});
	});

	describe('Market positions check', () => {
		it('Should return market position (single positions) as winning - status: WINNING, result type: EXACT POSITION', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]]);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(MARKET_POSITION_STATUS.Winning);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(false);
		});

		it('Should return market position (single positions) as winning - status: CANCELLED, result type: EXACT POSITION', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.cancelGames([GAME_ID_1]);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(MARKET_POSITION_STATUS.Cancelled);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(GAME_ID_1, 0, 0, 0, 1, [])
			).to.equal(true);
		});

		it('Should return market position (single positions) as losing - status: LOSING, result type: EXACT POSITION', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 0, [])
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]]);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 0, [])
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(GAME_ID_1, 0, 0, 0, 0, [])
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(GAME_ID_1, 0, 0, 0, 0, [])
			).to.equal(false);
		});

		it('Should return market position (single positions) as winning - status: WINNING, result type: OVER/UNDER (total)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL],
				[RESULT_TYPE.OverUnder]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[[UNDER_TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Winning);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(false);
		});

		it('Should return market position (single positions) as winning - status: WINNING, result type: OVER/UNDER (spread)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_SPREAD],
				[RESULT_TYPE.OverUnder]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_SPREAD],
				[0],
				[[UNDER_SPREAD_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Winning);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					1,
					[]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					1,
					[]
				)
			).to.equal(false);
		});

		it('Should return market position (single positions) as winning - status: CANCELLED (cancelled game), result type: OVER/UNDER', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL],
				[RESULT_TYPE.OverUnder]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.cancelGames([GAME_ID_1]);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Cancelled);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(true);
		});

		it('Should return market position (single positions) as winning - status: CANCELLED (by results), result type: OVER/UNDER', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL],
				[RESULT_TYPE.OverUnder]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[[TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Cancelled);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					1,
					[]
				)
			).to.equal(true);
		});

		it('Should return market position (single positions) as losing - status: LOSING, result type: OVER/UNDER (total)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL],
				[RESULT_TYPE.OverUnder]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					0,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[[UNDER_TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					0,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					0,
					[]
				)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_TOTAL,
					0,
					TOTAL_LINE,
					0,
					[]
				)
			).to.equal(false);
		});

		it('Should return market position (single positions) as losing - status: LOSING, result type: OVER/UNDER (spread)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_SPREAD],
				[RESULT_TYPE.OverUnder]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					0,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_SPREAD],
				[0],
				[[UNDER_SPREAD_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					0,
					[]
				)
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					0,
					[]
				)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_SPREAD,
					0,
					SPREAD_LINE,
					0,
					[]
				)
			).to.equal(false);
		});

		it('Should return market position (combined positions) as winning - status: WINNING', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results only for moneyline
			await sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]]);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results for total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[[UNDER_TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Winning);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(false);
		});

		it('Should return market position (combined positions) as winning - status: CANCELLED (position #1: open, position #2: cancelled)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// cancel only total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[[TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Cancelled);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
		});

		it('Should return market position (combined positions) as winning - status: CANCELLED (position #1: winning, position #2: cancelled)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results for moneyline and total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1, GAME_ID_1],
				[0, TYPE_ID_TOTAL],
				[0, 0],
				[[1], [TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Cancelled);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
		});

		it('Should return market position (combined positions) as winning - status: CANCELLED (position #1: cancelled, position #2: cancelled)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// cancel game
			await sportsAMMV2ResultManager.cancelGames([GAME_ID_1]);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(MARKET_POSITION_STATUS.Cancelled);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[3]
				)
			).to.equal(true);
		});

		it('Should return market position (combined positions) as losing - status: LOSING (position #1: open, position #2: losing)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results only for total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[[UNDER_TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(false);
		});

		it('Should return market position (combined positions) as losing - status: LOSING (position #1: winning, position #2: losing)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results for moneyline and total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1, GAME_ID_1],
				[0, TYPE_ID_TOTAL],
				[0, 0],
				[[1], [UNDER_TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[2]
				)
			).to.equal(false);
		});

		it('Should return market position (combined positions) as losing - status: LOSING (position #1: losing, position #2: cancelled)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[1]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results for moneyline and total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1, GAME_ID_1],
				[0, TYPE_ID_TOTAL],
				[0, 0],
				[[1], [TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[1]
				)
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[1]
				)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[1]
				)
			).to.equal(false);
		});

		it('Should return market position (combined positions) as losing - status: LOSING (position #1: losing, position #2: losing)', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[0, TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.ExactPosition, RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);

			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(MARKET_POSITION_STATUS.Open);

			// set results for moneyline and total
			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1, GAME_ID_1],
				[0, TYPE_ID_TOTAL],
				[0, 0],
				[[1], [UNDER_TOTAL_LINE]]
			);

			// check market position status
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(MARKET_POSITION_STATUS.Losing);
			expect(
				await sportsAMMV2ResultManager.isWinningMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isCancelledMarketPosition(
					GAME_ID_1,
					TYPE_ID_WINNER_TOTAL,
					0,
					0,
					0,
					WINNER_TOTAL_COMBINED_POSTIONS[0]
				)
			).to.equal(false);
		});
	});
});
