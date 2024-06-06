const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { SPORT_ID_NBA, BUY_IN_AMOUNT, RISK_STATUS } = require('../../../constants/overtime');

describe('SportsAMMV2RiskManager Invalid Ticket Combination', () => {
	let sportsAMMV2RiskManager,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		tradeDataSameGames,
		sameGameWithFirstPlayerProps,
		sameGameWithSecondPlayerProps,
		sameGameDifferentPlayersDifferentProps,
		sameGameSamePlayersDifferentProps,
		secondAccount;

	beforeEach(async () => {
		({
			sportsAMMV2RiskManager,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			tradeDataSameGames,
			sameGameWithFirstPlayerProps,
			sameGameWithSecondPlayerProps,
			sameGameDifferentPlayersDifferentProps,
			sameGameSamePlayersDifferentProps,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Ticket with valid combinations', () => {
		it('Should pass with 1 market on ticket', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});
		it('Should pass with 10 markets on ticket', async () => {
			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataTenMarketsCurrentRound,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});
	});

	describe('Ticket with invalid combinations', () => {
		it('Should fail if combining not set on sport', async () => {
			let checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameDifferentPlayersDifferentProps,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);

			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameDifferentPlayersDifferentProps,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.NoRisk);
		});

		it('Should fail with same players on same game', async () => {
			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameSamePlayersDifferentProps,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);
		});

		it('Should fail with same games on ticket', async () => {
			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			const checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				tradeDataSameGames,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);
		});

		it('Should fail with same games with one player props on ticket', async () => {
			await sportsAMMV2RiskManager.setCombiningPerSportEnabled(SPORT_ID_NBA, true);

			let checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameWithFirstPlayerProps,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);

			checkRisksData = await sportsAMMV2RiskManager.checkRisks(
				sameGameWithSecondPlayerProps,
				BUY_IN_AMOUNT,
				false
			);

			expect(checkRisksData.riskStatus).to.equal(RISK_STATUS.InvalidCombination);
		});

		it('Should fail with "Only the contract owner may perform this action"', async () => {
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCombiningPerSportEnabled(SPORT_ID_NBA, true)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});
	});
});
