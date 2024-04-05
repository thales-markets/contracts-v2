const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');
const { ONE_DAY_IN_SECS } = require('../../../constants/general');
const {
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	TYPE_ID_SPREAD,
	TYPE_ID_TOTAL,
	TYPE_ID_POINTS,
	GAME_ID_1,
	TOTAL_LINE,
} = require('../../../constants/overtime');
const { RISK_MANAGER_PARAMS } = require('../../../constants/overtimeContractParams');

describe('SportsAMMV2RiskManager Get Risk Data', () => {
	let sportsAMMV2RiskManager,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		tradeIllegalCombinationCurrentRound,
		sameGameDifferentPlayerProps,
		sameGameSamePlayersDifferentProps;

	const {
		newCapForSport,
		newCapForSportChild,
		newCapForSportAndType,
		newCapForMarket,
		newRiskMultiplierForSport,
		newRiskMultiplierForMarket,
		newDynamicLiquidityCutoffTime,
		newDynamicLiquidityCutoffDivider,
	} = RISK_MANAGER_PARAMS;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			tradeIllegalCombinationCurrentRound,
			sameGameDifferentPlayerProps,
			sameGameSamePlayersDifferentProps,
		} = await loadFixture(deploySportsAMMV2Fixture));
	});

	describe('Normal parlays', () => {
		it('Should pass', async () => {
			const allowed =
				await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(tradeDataCurrentRound);

			expect(allowed).to.equal(false);
		});
		it('Should pass 10 leg parlay', async () => {
			const allowed = await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(
				tradeDataTenMarketsCurrentRound
			);

			expect(allowed).to.equal(false);
		});
	});

	describe('Illegal parlays', () => {
		it('Should fail', async () => {
			const allowed = await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(
				tradeIllegalCombinationCurrentRound
			);

			expect(allowed).to.equal(true);
		});

		it('Should fail if combining not set on sport', async () => {
			let allowed = await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(
				sameGameDifferentPlayerProps
			);

			expect(allowed).to.equal(true);

			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			allowed = await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(
				sameGameDifferentPlayerProps
			);

			expect(allowed).to.equal(false);
		});

		it('Should fail with same players on same game', async () => {
			let allowed = await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(
				sameGameSamePlayersDifferentProps
			);

			expect(allowed).to.equal(true);

			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			allowed = await sportsAMMV2RiskManager.hasIllegalCombinationsOnTicket(
				sameGameSamePlayersDifferentProps
			);

			expect(allowed).to.equal(true);
		});
	});
});
