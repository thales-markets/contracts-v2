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

			await expect(
				sportsAMMV2ResultManager
					.connect(secondAccount)
					.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]])
			).to.be.revertedWith('Only the contract owner may perform this action');

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
				[[1], [24000]]
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
		it('Should return market position as winning - WINNING status (single positions)', async () => {
			expect(
				await sportsAMMV2ResultManager.getMarketPositionStatus(GAME_ID_1, 0, 0, 0, 0, [])
			).to.equal(MARKET_POSITION_STATUS.Open);

			// await expect(
			// 	sportsAMMV2ResultManager
			// 		.connect(secondAccount)
			// 		.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]])
			// ).to.be.revertedWith('Only the contract owner may perform this action');

			// await sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]]);

			// // check resolve game 1
			// expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
			// 	true
			// );
			// expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
			// 	false
			// );
		});

		// it('Should return market as resolved (combined positions)', async () => {
		// 	await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
		// 		[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
		// 		[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
		// 	);

		// 	expect(
		// 		await sportsAMMV2ResultManager.isMarketResolved(
		// 			GAME_ID_1,
		// 			TYPE_ID_WINNER_TOTAL,
		// 			0,
		// 			0,
		// 			WINNER_TOTAL_COMBINED_POSTIONS[0]
		// 		)
		// 	).to.equal(false);

		// 	await sportsAMMV2ResultManager.setResultsPerMarkets(
		// 		[GAME_ID_1, GAME_ID_1],
		// 		[0, TYPE_ID_TOTAL],
		// 		[0, 0],
		// 		[[1], [24000]]
		// 	);

		// 	// check resolve game 1
		// 	expect(
		// 		await sportsAMMV2ResultManager.isMarketResolved(
		// 			GAME_ID_1,
		// 			TYPE_ID_WINNER_TOTAL,
		// 			0,
		// 			0,
		// 			WINNER_TOTAL_COMBINED_POSTIONS[0]
		// 		)
		// 	).to.equal(true);
		// 	expect(
		// 		await sportsAMMV2ResultManager.isMarketCancelled(
		// 			GAME_ID_1,
		// 			TYPE_ID_WINNER_TOTAL,
		// 			0,
		// 			0,
		// 			WINNER_TOTAL_COMBINED_POSTIONS[0]
		// 		)
		// 	).to.equal(false);
		// });
	});
});
