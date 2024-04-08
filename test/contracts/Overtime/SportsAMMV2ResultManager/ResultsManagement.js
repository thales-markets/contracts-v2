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
	GAME_ID_2,
	GAME_ID_3,
	GAME_ID_4,
} = require('../../../constants/overtime');

describe('SportsAMMV2ResultManager Results Management', () => {
	let sportsAMMV2ResultManager, secondAccount;

	beforeEach(async () => {
		({ sportsAMMV2ResultManager } = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Result type setters', () => {
		it('Should set the new result type per market type', async () => {
			expect(await sportsAMMV2ResultManager.resultTypePerMarketType(TYPE_ID_TOTAL)).to.equal(0);
			expect(await sportsAMMV2ResultManager.resultTypePerMarketType(TYPE_ID_WINNER_TOTAL)).to.equal(
				0
			);

			await expect(
				sportsAMMV2ResultManager
					.connect(secondAccount)
					.setResultTypesPerMarketTypes(
						[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
						[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
					)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
				[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
				[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
			);
			expect(await sportsAMMV2ResultManager.resultTypePerMarketType(TYPE_ID_TOTAL)).to.equal(
				RESULT_TYPE.OverUnder
			);
			expect(await sportsAMMV2ResultManager.resultTypePerMarketType(TYPE_ID_WINNER_TOTAL)).to.equal(
				RESULT_TYPE.CombinedPositions
			);

			await expect(
				sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
					[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
					[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions]
				)
			)
				.to.emit(sportsAMMV2ResultManager, 'ResultTypePerMarketTypeSet')
				.withArgs(TYPE_ID_TOTAL, RESULT_TYPE.OverUnder)
				.to.emit(sportsAMMV2ResultManager, 'ResultTypePerMarketTypeSet')
				.withArgs(TYPE_ID_WINNER_TOTAL, RESULT_TYPE.CombinedPositions);
		});

		it('Should fail with "Invalid result type"', async () => {
			await expect(
				sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
					[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
					[RESULT_TYPE.OverUnder, RESULT_TYPE.CombinedPositions + 1]
				)
			).to.be.revertedWith('Invalid result type');
			await expect(
				sportsAMMV2ResultManager.setResultTypesPerMarketTypes(
					[TYPE_ID_TOTAL, TYPE_ID_WINNER_TOTAL],
					[RESULT_TYPE.OverUnder, RESULT_TYPE.Unassigned]
				)
			).to.be.revertedWith('Invalid result type');
		});
	});

	describe('Results setters', () => {
		it('Should set results per markets', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_1, 0, 0)).to.equal(
				false
			);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_1, 0, 0, 0)
			).to.be.revertedWithoutReason();
			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_2, 0, 0)).to.equal(
				false
			);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_2, 0, 0, 0)
			).to.be.revertedWithoutReason();

			await expect(
				sportsAMMV2ResultManager
					.connect(secondAccount)
					.setResultsPerMarkets([GAME_ID_1, GAME_ID_2], [0, 0], [0, 0], [[1], [2]])
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[GAME_ID_1, GAME_ID_2],
				[0, 0],
				[0, 0],
				[[1], [2]]
			);

			// check results set for game 1
			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_1, 0, 0)).to.equal(true);
			expect(await sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_1, 0, 0, 0)).to.equal(1);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_1, 0, 0, 1)
			).to.be.revertedWithoutReason();
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
				false
			);
			expect((await sportsAMMV2ResultManager.getResultsPerMarket(GAME_ID_1, 0, 0)).length).to.equal(
				1
			);

			// check results set for game 2
			expect(await sportsAMMV2ResultManager.areResultsPerMarketSet(GAME_ID_2, 0, 0)).to.equal(true);
			expect(await sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_2, 0, 0, 0)).to.equal(2);
			await expect(
				sportsAMMV2ResultManager.resultsPerMarket(GAME_ID_2, 0, 0, 1)
			).to.be.revertedWithoutReason();
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_2, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_2, 0, 0, 0, [])).to.equal(
				false
			);
			expect((await sportsAMMV2ResultManager.getResultsPerMarket(GAME_ID_2, 0, 0)).length).to.equal(
				1
			);

			await expect(
				sportsAMMV2ResultManager.setResultsPerMarkets(
					[GAME_ID_3, GAME_ID_4],
					[0, 0],
					[0, 0],
					[[0], [1]]
				)
			)
				.to.emit(sportsAMMV2ResultManager, 'ResultsPerMarketSet')
				.withArgs(GAME_ID_3, 0, 0, [0])
				.to.emit(sportsAMMV2ResultManager, 'ResultsPerMarketSet')
				.withArgs(GAME_ID_4, 0, 0, [1]);
		});

		it('Should fail with "Results already set per market"', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]]);
			await expect(
				sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]])
			).to.be.revertedWith('Results already set per market');
		});

		it('Should fail with "Result type not set"', async () => {
			await expect(
				sportsAMMV2ResultManager.setResultsPerMarkets([GAME_ID_1], [0], [0], [[1]])
			).to.be.revertedWith('Result type not set');
		});
	});

	describe('Cancel', () => {
		it('Should cancel games', async () => {
			expect(await sportsAMMV2ResultManager.isGameCancelled(GAME_ID_1)).to.equal(false);
			expect(await sportsAMMV2ResultManager.isGameCancelled(GAME_ID_2)).to.equal(false);

			await expect(
				sportsAMMV2ResultManager.connect(secondAccount).cancelGames([GAME_ID_1, GAME_ID_2])
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2ResultManager.cancelGames([GAME_ID_1, GAME_ID_2]);

			// check cancel for game 1
			expect(await sportsAMMV2ResultManager.isGameCancelled(GAME_ID_1)).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_1, 0, 0, 0)
			).to.equal(false);
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect((await sportsAMMV2ResultManager.getResultsPerMarket(GAME_ID_1, 0, 0)).length).to.equal(
				0
			);

			// check cancel for game 2
			expect(await sportsAMMV2ResultManager.isGameCancelled(GAME_ID_2)).to.equal(true);
			expect(
				await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_2, 0, 0, 0)
			).to.equal(false);
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_2, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_2, 0, 0, 0, [])).to.equal(
				true
			);
			expect((await sportsAMMV2ResultManager.getResultsPerMarket(GAME_ID_2, 0, 0)).length).to.equal(
				0
			);

			await expect(sportsAMMV2ResultManager.cancelGames([GAME_ID_3, GAME_ID_4]))
				.to.emit(sportsAMMV2ResultManager, 'GameCancelled')
				.withArgs(GAME_ID_3)
				.to.emit(sportsAMMV2ResultManager, 'GameCancelled')
				.withArgs(GAME_ID_4);
		});

		it('Should fail with "Game already cancelled"', async () => {
			await sportsAMMV2ResultManager.cancelGames([GAME_ID_1]);
			await expect(sportsAMMV2ResultManager.cancelGames([GAME_ID_1])).to.be.revertedWith(
				'Game already cancelled'
			);

			await expect(sportsAMMV2ResultManager.cancelGames([GAME_ID_2, GAME_ID_2])).to.be.revertedWith(
				'Game already cancelled'
			);
		});

		it('Should cancel markets', async () => {
			expect(
				await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_1, 0, 0, 0)
			).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_2, 0, 0, 0)
			).to.equal(false);

			await expect(
				sportsAMMV2ResultManager
					.connect(secondAccount)
					.cancelMarkets([GAME_ID_1, GAME_ID_2], [0, 0], [0, 0], [0, 0])
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2ResultManager.cancelMarkets([GAME_ID_1, GAME_ID_2], [0, 0], [0, 0], [0, 0]);

			// check cancel for game 1
			expect(await sportsAMMV2ResultManager.isGameCancelled(GAME_ID_1)).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_1, 0, 0, 0)
			).to.equal(true);
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_1, 0, 0, 0, [])).to.equal(
				true
			);
			expect((await sportsAMMV2ResultManager.getResultsPerMarket(GAME_ID_1, 0, 0)).length).to.equal(
				0
			);

			// check cancel for game 2
			expect(await sportsAMMV2ResultManager.isGameCancelled(GAME_ID_2)).to.equal(false);
			expect(
				await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_2, 0, 0, 0)
			).to.equal(true);
			expect(await sportsAMMV2ResultManager.isMarketResolved(GAME_ID_2, 0, 0, 0, [])).to.equal(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketCancelled(GAME_ID_2, 0, 0, 0, [])).to.equal(
				true
			);
			expect((await sportsAMMV2ResultManager.getResultsPerMarket(GAME_ID_2, 0, 0)).length).to.equal(
				0
			);

			await expect(
				sportsAMMV2ResultManager.cancelMarkets([GAME_ID_3, GAME_ID_4], [0, 0], [0, 0], [0, 0])
			)
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_3, 0, 0, 0)
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_4, 0, 0, 0);
		});

		it('Should fail with "Market already cancelled"', async () => {
			await sportsAMMV2ResultManager.cancelMarkets([GAME_ID_1], [0], [0], [0]);
			await expect(
				sportsAMMV2ResultManager.cancelMarkets([GAME_ID_1], [0], [0], [0])
			).to.be.revertedWith('Market already cancelled');

			await sportsAMMV2ResultManager.cancelGames([GAME_ID_2]);
			await expect(
				sportsAMMV2ResultManager.cancelMarkets([GAME_ID_2], [0], [0], [0])
			).to.be.revertedWith('Market already cancelled');

			await expect(
				sportsAMMV2ResultManager.cancelMarkets([GAME_ID_3, GAME_ID_3], [0, 0], [0, 0], [0, 0])
			).to.be.revertedWith('Market already cancelled');
		});
	});
});
