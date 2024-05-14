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
	SPORT_ID_NBA,
} = require('../../../constants/overtime');

const bytes32 = require('bytes32');

describe('SportsAMMV2ResultManager Results Management', () => {
	let sportsAMMV2ResultManager, firstTrader, chainlinkResolver, mockChainlinkOracle, collateral;

	beforeEach(async () => {
		({ sportsAMMV2ResultManager, chainlinkResolver, mockChainlinkOracle, collateral } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ firstTrader } = await loadFixture(deployAccountsFixture));
	});

	describe('Results setters', () => {
		it('Should set results per markets via chainlink', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await chainlinkResolver
				.connect(firstTrader)
				.requestMarketResolving(
					SPORT_ID_NBA,
					'1715117924',
					[bytes32({ input: GAME_ID_3 }), bytes32({ input: GAME_ID_4 })],
					['0', '0'],
					['0', '0']
				);

			let requestId = await chainlinkResolver.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await expect(mockChainlinkOracle.fulfillMarketResolve(requestId, [[0], [1]]))
				.to.emit(sportsAMMV2ResultManager, 'ResultsPerMarketSet')
				.withArgs(GAME_ID_3, 0, 0, [0])
				.to.emit(sportsAMMV2ResultManager, 'ResultsPerMarketSet')
				.withArgs(GAME_ID_4, 0, 0, [1]);
		});

		it('Should cancel a game via chainlink', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await chainlinkResolver
				.connect(firstTrader)
				.requestMarketResolving(
					SPORT_ID_NBA,
					'1715117924',
					[bytes32({ input: GAME_ID_3 }), bytes32({ input: GAME_ID_4 })],
					['0', '0'],
					['0', '0']
				);

			let requestId = await chainlinkResolver.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await expect(mockChainlinkOracle.fulfillMarketResolve(requestId, [[-9999], [-9999]]))
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_3, 0, 0, 0)
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_4, 0, 0, 0);
		});

		it('Should cancel a market via chainlink', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await chainlinkResolver
				.connect(firstTrader)
				.requestMarketResolving(
					SPORT_ID_NBA,
					'1715117924',
					[bytes32({ input: GAME_ID_3 }), bytes32({ input: GAME_ID_4 })],
					['1', '2'],
					['0', '0']
				);

			let requestId = await chainlinkResolver.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			//emit MarketExplicitlyCancelled(_gameId, _typeId, _playerId, _line);

			await expect(mockChainlinkOracle.fulfillMarketResolve(requestId, [[-9999], [-9999]]))
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_3, 1, 0, 0)
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_4, 2, 0, 0);

			expect(await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_3, 1, 0, 0)).to.eq(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_3, 1, 0, 1)).to.eq(
				false
			);
		});

		it('Should cancel a market and resolve one normally via chainlink', async () => {
			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await chainlinkResolver
				.connect(firstTrader)
				.requestMarketResolving(
					SPORT_ID_NBA,
					'1715117924',
					[bytes32({ input: GAME_ID_3 }), bytes32({ input: GAME_ID_4 })],
					['1', '0'],
					['0', '0']
				);

			let requestId = await chainlinkResolver.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			//emit MarketExplicitlyCancelled(_gameId, _typeId, _playerId, _line);

			await expect(mockChainlinkOracle.fulfillMarketResolve(requestId, [[-9999], [1]]))
				.to.emit(sportsAMMV2ResultManager, 'MarketExplicitlyCancelled')
				.withArgs(GAME_ID_3, 1, 0, 0)
				.to.emit(sportsAMMV2ResultManager, 'ResultsPerMarketSet')
				.withArgs(GAME_ID_4, 0, 0, [1]);

			expect(await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_3, 1, 0, 0)).to.eq(
				true
			);
			expect(await sportsAMMV2ResultManager.isMarketExplicitlyCancelled(GAME_ID_3, 1, 0, 1)).to.eq(
				false
			);
		});

		it('Setters', async () => {
			await chainlinkResolver.setPaused(true);

			const collateralAddress = await collateral.getAddress();
			const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';
			await chainlinkResolver.setConfiguration(
				collateralAddress, //link
				collateralAddress, //_oracle
				collateralAddress, // _sportsAMM
				collateralAddress, // _riskManager
				mockSpecId, // _specId
				0 // payment
			);
		});
	});
});
