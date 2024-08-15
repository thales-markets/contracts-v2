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
	let sportsAMMV2RiskManager;

	const {
		newCapForSport,
		newCapForSportChild,
		newCapForSportAndType,
		newCapForMarket,
		newRiskMultiplierForSport,
		newRiskMultiplierForGame,
		newDynamicLiquidityCutoffTime,
		newDynamicLiquidityCutoffDivider,
	} = RISK_MANAGER_PARAMS;

	beforeEach(async () => {
		({ sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2Fixture));
	});

	describe('Get data', () => {
		it('Should get risk data (caps)', async () => {
			await sportsAMMV2RiskManager.setCaps(
				[SPORT_ID_NBA],
				[newCapForSport],
				[SPORT_ID_EPL],
				[newCapForSportChild],
				[SPORT_ID_EPL, SPORT_ID_EPL, SPORT_ID_NBA],
				[TYPE_ID_SPREAD, TYPE_ID_TOTAL, TYPE_ID_POINTS],
				[newCapForSportAndType, 0, newCapForSportAndType]
			);

			const riskData = await sportsAMMV2RiskManager.getRiskData(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[TYPE_ID_POINTS, TYPE_ID_SPREAD, TYPE_ID_TOTAL]
			);

			// NBA
			expect(riskData[0].capData.capPerSport).to.equal(newCapForSport);
			expect(riskData[0].capData.capPerChild).to.equal(0);
			expect(
				riskData[0].capData.capPerType.find(
					(capPerType) => Number(capPerType.typeId) === TYPE_ID_POINTS
				).cap
			).to.equal(newCapForSportAndType);

			// EPL
			expect(riskData[1].capData.capPerSport).to.equal(0);
			expect(riskData[1].capData.capPerChild).to.equal(newCapForSportChild);
			expect(
				riskData[1].capData.capPerType.find(
					(capPerType) => Number(capPerType.typeId) === TYPE_ID_SPREAD
				).cap
			).to.equal(newCapForSportAndType);
			expect(
				riskData[1].capData.capPerType.find(
					(capPerType) => Number(capPerType.typeId) === TYPE_ID_TOTAL
				).cap
			).to.equal(0);
		});
	});

	describe('Get cap', () => {
		let maturity, defaultCap;

		beforeEach(async () => {
			maturity = (await time.latest()) + ONE_DAY_IN_SECS;
			defaultCap = await sportsAMMV2RiskManager.defaultCap();
		});

		it('Should get cap 0 for market maturity in past', async () => {
			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				(await time.latest()) - ONE_DAY_IN_SECS,
				false
			);

			expect(cap).to.equal(0);
		});

		it('Should get cap for market (MONEYLINE) - default cap', async () => {
			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				maturity,
				false
			);

			expect(cap).to.equal(defaultCap);
		});

		it('Should get cap for market (TOTAL) - default cap / 2', async () => {
			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				0,
				TOTAL_LINE,
				maturity,
				false
			);

			expect(cap).to.equal(ethers.parseEther((ethers.formatEther(defaultCap) / 2).toString()));
		});

		it('Should get cap for market (MONEYLINE) - cap per sport', async () => {
			await sportsAMMV2RiskManager.setCapsPerSport([SPORT_ID_NBA], [newCapForSport]);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				maturity,
				false
			);

			expect(cap).to.equal(newCapForSport);
		});

		it('Should get cap for market (TOTAL) - cap per sport / 2', async () => {
			await sportsAMMV2RiskManager.setCapsPerSport([SPORT_ID_NBA], [newCapForSport]);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				0,
				TOTAL_LINE,
				maturity,
				false
			);

			expect(cap).to.equal(ethers.parseEther((ethers.formatEther(newCapForSport) / 2).toString()));
		});

		it('Should get cap for market (TOTAL) - cap per child', async () => {
			await sportsAMMV2RiskManager.setCapsPerSportChild([SPORT_ID_NBA], [newCapForSportChild]);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				0,
				TOTAL_LINE,
				maturity,
				false
			);

			expect(cap).to.equal(newCapForSportChild);
		});

		it('Should get cap for market (TOTAL) - cap per sport and type', async () => {
			await sportsAMMV2RiskManager.setCapsPerSportAndType(
				[SPORT_ID_NBA],
				[TYPE_ID_TOTAL],
				[newCapForSportAndType]
			);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				0,
				TOTAL_LINE,
				maturity,
				false
			);

			expect(cap).to.equal(newCapForSportAndType);
		});

		it('Should get cap for market (TOTAL) - cap per sport and type even if child market is set ', async () => {
			await sportsAMMV2RiskManager.setCapsPerSportAndType(
				[SPORT_ID_NBA],
				[TYPE_ID_TOTAL],
				[newCapForSportAndType]
			);

			await sportsAMMV2RiskManager.setCapsPerSportChild([SPORT_ID_NBA], [newCapForSportChild]);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				0,
				TOTAL_LINE,
				maturity,
				false
			);

			expect(cap).to.equal(newCapForSportAndType);
		});

		it('Should get cap for market (TOTAL) - cap per market', async () => {
			await sportsAMMV2RiskManager.setCapsPerMarket(
				[GAME_ID_1],
				[TYPE_ID_TOTAL],
				[0],
				[TOTAL_LINE],
				[newCapForMarket]
			);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				0,
				TOTAL_LINE,
				maturity,
				false
			);

			expect(cap).to.equal(newCapForMarket);
		});

		it('Should get cap for market (MONEYLINE) - dynamic liquidity', async () => {
			const formattedDefaultCap = ethers.formatEther(defaultCap);

			// default cap
			let cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				0,
				0,
				0,
				maturity,
				false
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
				maturity,
				false
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
				maturity,
				false
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
				maturity,
				false
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
				maturity,
				false
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
				maturity,
				false
			);
			expect(cap).to.equal(defaultCap);
		});
	});

	describe('Get risk', () => {
		let maturity, defaultCap, defaultRiskMultiplier;

		beforeEach(async () => {
			maturity = (await time.latest()) + ONE_DAY_IN_SECS;
			defaultCap = await sportsAMMV2RiskManager.defaultCap();
			defaultRiskMultiplier = Number(await sportsAMMV2RiskManager.defaultRiskMultiplier());
		});

		it('Should get total risk on game - default cap, default risk', async () => {
			const formattedDefaultCap = Number(ethers.formatEther(defaultCap));

			const totalRiskOnGame = await sportsAMMV2RiskManager.calculateTotalRiskOnGame(
				GAME_ID_1,
				SPORT_ID_NBA,
				maturity
			);

			expect(Number(ethers.formatEther(totalRiskOnGame))).to.equal(
				formattedDefaultCap * defaultRiskMultiplier
			);
		});

		it('Should get total risk on game - cap per sport, default risk', async () => {
			const formattedNewCapForSport = Number(ethers.formatEther(newCapForSport));

			await sportsAMMV2RiskManager.setCapsPerSport([SPORT_ID_NBA], [newCapForSport]);

			const totalRiskOnGame = await sportsAMMV2RiskManager.calculateTotalRiskOnGame(
				GAME_ID_1,
				SPORT_ID_NBA,
				maturity
			);

			expect(Number(ethers.formatEther(totalRiskOnGame))).to.equal(
				formattedNewCapForSport * defaultRiskMultiplier
			);
		});

		it('Should get total risk on game - default cap, risk per sport', async () => {
			const formattedDefaultCap = Number(ethers.formatEther(defaultCap));

			await sportsAMMV2RiskManager.setRiskMultipliersPerSport(
				[SPORT_ID_NBA],
				[newRiskMultiplierForSport]
			);

			const totalRiskOnGame = await sportsAMMV2RiskManager.calculateTotalRiskOnGame(
				GAME_ID_1,
				SPORT_ID_NBA,
				maturity
			);

			expect(Number(ethers.formatEther(totalRiskOnGame))).to.equal(
				formattedDefaultCap * newRiskMultiplierForSport
			);
		});

		it('Should get total risk on game - default cap, risk per sport, risk per game', async () => {
			const formattedDefaultCap = Number(ethers.formatEther(defaultCap));

			await sportsAMMV2RiskManager.setRiskMultipliersPerSport(
				[SPORT_ID_NBA],
				[newRiskMultiplierForSport]
			);
			await sportsAMMV2RiskManager.setRiskMultipliersPerGame(
				[GAME_ID_1],
				[newRiskMultiplierForGame]
			);

			const totalRiskOnGame = await sportsAMMV2RiskManager.calculateTotalRiskOnGame(
				GAME_ID_1,
				SPORT_ID_NBA,
				maturity
			);

			expect(Number(ethers.formatEther(totalRiskOnGame))).to.equal(
				formattedDefaultCap * newRiskMultiplierForGame
			);
		});
	});
});
