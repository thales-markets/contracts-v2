const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');
const { SPORT_ID_NBA, BUY_IN_AMOUNT, RISK_STATUS } = require('../../../constants/overtime');

describe('SportsAMMV2RiskManager Invalid Ticket Combination', () => {
	let sportsAMMV2RiskManager,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		tradeIllegalCombinationCurrentRound,
		sameGameDifferentPlayerProps,
		sameGameSamePlayersDifferentProps;

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

	describe('Normal ticket', () => {
		it('Should pass', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});
		it('Should pass 10 leg ticket', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});
	});

	describe('Invalid ticket', () => {
		it('Should fail with the same games on ticket', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeIllegalCombinationCurrentRound,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);
		});

		it('Should fail if combining not set on sport', async () => {
			let checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameDifferentPlayerProps,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);

			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameDifferentPlayerProps,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});

		it('Should fail with same players on same game', async () => {
			let checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameSamePlayersDifferentProps,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);

			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameSamePlayersDifferentProps,
				BUY_IN_AMOUNT
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);
		});
	});
});
