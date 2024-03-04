const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');
const { ONE_DAY_IN_SECS } = require('../../../constants/general');
const {
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	CHILD_ID_SPREAD,
	CHILD_ID_TOTAL,
	CHILD_ID_PLAYER_PROPS,
	GAME_ID_1,
	TOTAL_LINE,
} = require('../../../constants/overtime');
const { RISK_MANAGER_PARAMS } = require('../../../constants/overtimeContractParams');

describe('SportsAMMV2RiskManager Get Risk Data', () => {
	let sportsAMMV2RiskManager;

	const {
		newCapForSport,
		newCapForSportAndChild,
		newCapForGame,
		newRiskMultiplierForSport,
		newRiskMultiplierForGame,
		newDynamicLiquidityCutoffTime,
		newDynamicLiquidityCutoffDivider,
	} = RISK_MANAGER_PARAMS;

	beforeEach(async () => {
		({ sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2Fixture));
	});

	describe('Get data', () => {
		it('Should get all data for sports', async () => {
			await sportsAMMV2RiskManager.setCaps(
				[SPORT_ID_NBA],
				[newCapForSport],
				[SPORT_ID_EPL, SPORT_ID_EPL, SPORT_ID_NBA],
				[CHILD_ID_SPREAD, CHILD_ID_TOTAL, CHILD_ID_PLAYER_PROPS],
				[newCapForSportAndChild, newCapForSportAndChild, newCapForSportAndChild]
			);

			const allDataForSports = await sportsAMMV2RiskManager.getAllDataForSports([
				SPORT_ID_NBA,
				SPORT_ID_EPL,
			]);

			// NBA
			expect(allDataForSports.capsPerSport[0]).to.equal(newCapForSport);
			expect(allDataForSports.capsPerSportH[0]).to.equal(0);
			expect(allDataForSports.capsPerSportT[0]).to.equal(0);
			expect(allDataForSports.capsPerSportPP[0]).to.equal(newCapForSportAndChild);

			// EPL
			expect(allDataForSports.capsPerSport[1]).to.equal(0);
			expect(allDataForSports.capsPerSportH[1]).to.equal(newCapForSportAndChild);
			expect(allDataForSports.capsPerSportT[1]).to.equal(newCapForSportAndChild);
			expect(allDataForSports.capsPerSportPP[1]).to.equal(0);
		});
	});

	describe('Get cap', () => {
		let maturity, defaultCap;

		beforeEach(async () => {
			maturity = (await time.latest()) + ONE_DAY_IN_SECS;
			defaultCap = await sportsAMMV2RiskManager.defaultCap();
		});

		it('Should get cap for game (MONEYLINE) - default cap', async () => {
			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);

			expect(cap).to.equal(defaultCap);
		});

		it('Should get cap for child game (TOTAL) - default cap / 2', async () => {
			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				0,
				0,
				TOTAL_LINE,
				maturity
			);

			expect(cap).to.equal(ethers.parseEther((ethers.formatEther(defaultCap) / 2).toString()));
		});

		it('Should get cap for game (MONEYLINE) - cap per sport', async () => {
			await sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForSport);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);

			expect(cap).to.equal(newCapForSport);
		});

		it('Should get cap for child game (TOTAL) - cap per sport / 2', async () => {
			await sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForSport);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				0,
				0,
				TOTAL_LINE,
				maturity
			);

			expect(cap).to.equal(ethers.parseEther((ethers.formatEther(newCapForSport) / 2).toString()));
		});

		it('Should get cap for child game (TOTAL) - cap per sport and child', async () => {
			await sportsAMMV2RiskManager.setCapPerSportAndChild(
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				newCapForSportAndChild
			);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				0,
				0,
				TOTAL_LINE,
				maturity
			);

			expect(cap).to.equal(newCapForSportAndChild);
		});

		it('Should get cap for child game (TOTAL) - cap per game', async () => {
			await sportsAMMV2RiskManager.setCapPerGame(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[CHILD_ID_TOTAL],
				[0],
				[0],
				[TOTAL_LINE],
				newCapForGame
			);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				0,
				0,
				TOTAL_LINE,
				maturity
			);

			expect(cap).to.equal(newCapForGame);
		});

		it('Should get cap for game (MONEYLINE) - dynamic liquidity', async () => {
			const formattedDefaultCap = ethers.formatEther(defaultCap);

			// default cap
			let cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);
			expect(cap).to.equal(defaultCap);

			// set dynamic liquidity params: 6 hours cut off time, 4 divider
			await sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(
				SPORT_ID_NBA,
				newDynamicLiquidityCutoffTime,
				newDynamicLiquidityCutoffDivider
			);

			// divider is 4, cap should be 1/4 of default
			cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);
			expect(cap).to.equal(ethers.parseEther((formattedDefaultCap / 4).toString()));

			// set dynamic liquidity params: 6 hours cut off time, 0 divider (2 is by default)
			await sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(
				SPORT_ID_NBA,
				newDynamicLiquidityCutoffTime,
				0
			);

			// divider is by default 2, cap should be 1/2 of default
			cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);
			expect(cap).to.equal(ethers.parseEther((formattedDefaultCap / 2).toString()));

			// 3 hours before maturity, 1/2 of newDynamicLiquidityCutoffTime
			await time.increaseTo(maturity - 3 * 60 * 60);

			// divider is by default 2, time is 1/2 of newDynamicLiquidityCutoffTime, cap should be 3/4 of default (1/2 + 1/2*1/2)
			// due to linear increase of liquidity cap will be ~3/4 of default
			cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);
			expect(Number(ethers.formatEther(cap))).to.approximately((formattedDefaultCap * 3) / 4, 1);

			// set dynamic liquidity params: 6 hours cut off time, 4 divider
			await sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(
				SPORT_ID_NBA,
				newDynamicLiquidityCutoffTime,
				newDynamicLiquidityCutoffDivider
			);

			// divider is 4, time is 1/2 of newDynamicLiquidityCutoffTime, cap should be 5/8 of default (1/4 + 1/2*3/4)
			// due to linear increase of liquidity cap will be ~5/8 of default
			cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);
			expect(Number(ethers.formatEther(cap))).to.approximately((formattedDefaultCap * 5) / 8, 1);

			// reset dynamic liquidity params
			await sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(SPORT_ID_NBA, 0, 0);

			// cap should be reset to default
			cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				0,
				maturity
			);
			expect(cap).to.equal(defaultCap);
		});
	});

	describe('Get risk', () => {
		let maturity, totalSpent;

		beforeEach(async () => {
			maturity = (await time.latest()) + ONE_DAY_IN_SECS;
			totalSpent = ethers.parseEther('4000');
		});

		it('Should get total spending is more than total risk - default cap, default risk', async () => {
			const isTotalSpendingLessThanTotalRisk =
				await sportsAMMV2RiskManager.isTotalSpendingLessThanTotalRisk(
					totalSpent,
					GAME_ID_1,
					SPORT_ID_NBA,
					0,
					0,
					0,
					0,
					maturity
				);

			expect(isTotalSpendingLessThanTotalRisk).to.equal(false);
		});

		it('Should get total spending is less than total risk - cap per sport, default risk', async () => {
			await sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForSport);

			const isTotalSpendingLessThanTotalRisk =
				await sportsAMMV2RiskManager.isTotalSpendingLessThanTotalRisk(
					totalSpent,
					GAME_ID_1,
					SPORT_ID_NBA,
					0,
					0,
					0,
					0,
					maturity
				);

			expect(isTotalSpendingLessThanTotalRisk).to.equal(true);
		});

		it('Should get total spending is less than total risk - default cap, risk per sport', async () => {
			await sportsAMMV2RiskManager.setRiskMultiplierPerSport(
				SPORT_ID_NBA,
				newRiskMultiplierForSport
			);

			const isTotalSpendingLessThanTotalRisk =
				await sportsAMMV2RiskManager.isTotalSpendingLessThanTotalRisk(
					totalSpent,
					GAME_ID_1,
					SPORT_ID_NBA,
					0,
					0,
					0,
					0,
					maturity
				);

			expect(isTotalSpendingLessThanTotalRisk).to.equal(true);
		});

		it('Should get total spending is more than total risk - default cap, risk per sport, risk per game', async () => {
			await sportsAMMV2RiskManager.setRiskMultiplierPerSport(
				SPORT_ID_NBA,
				newRiskMultiplierForSport
			);
			await sportsAMMV2RiskManager.setRiskMultiplierPerGame(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[0],
				[0],
				[0],
				[0],
				newRiskMultiplierForGame
			);

			const isTotalSpendingLessThanTotalRisk =
				await sportsAMMV2RiskManager.isTotalSpendingLessThanTotalRisk(
					totalSpent,
					GAME_ID_1,
					SPORT_ID_NBA,
					0,
					0,
					0,
					0,
					maturity
				);

			expect(isTotalSpendingLessThanTotalRisk).to.equal(false);
		});
	});
});
