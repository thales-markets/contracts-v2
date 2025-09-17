const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deploySportsAMMV2Fixture } = require('../../../utils/fixtures/overtimeFixtures');
const { ONE_DAY_IN_SECS } = require('../../../constants/general');
const {
	SPORT_ID_NBA,
	TYPE_ID_TOTAL,
	TYPE_ID_SPREAD,
	GAME_ID_1,
	TOTAL_LINE,
} = require('../../../constants/overtime');

describe('SportsAMMV2RiskManager Cap Logic: Use 1/2 of Moneyline Market Cap (Per Market)', () => {
	let sportsAMMV2RiskManager;
	let maturity;

	beforeEach(async () => {
		({ sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2Fixture));
		maturity = (await time.latest()) + ONE_DAY_IN_SECS;
	});

	it('Should return half of explicitly set moneyline market cap for non-moneyline market on same game', async () => {
		const moneylineMarketCap = ethers.parseEther('20');
		await sportsAMMV2RiskManager.setCapsPerMarket([GAME_ID_1], [0], [0], [0], [moneylineMarketCap]);

		// set capPerSportAndType to something > 10 to allow moneyline cap to apply
		await sportsAMMV2RiskManager.setCapsPerSportAndType(
			[SPORT_ID_NBA],
			[TYPE_ID_TOTAL],
			[ethers.parseEther('100')]
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

		expect(cap).to.equal(ethers.parseEther('10')); // ✅ moneylineCap / 2 is lower
	});

	it('Should fallback to sport cap logic if no moneyline market cap is set', async () => {
		await sportsAMMV2RiskManager.setCapsPerMarket([GAME_ID_1], [0], [0], [0], [0]);
		await sportsAMMV2RiskManager.setCapsPerSport([SPORT_ID_NBA], [ethers.parseEther('30')]);

		const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
			GAME_ID_1,
			SPORT_ID_NBA,
			TYPE_ID_TOTAL,
			0,
			TOTAL_LINE,
			maturity,
			false
		);

		expect(cap).to.equal(ethers.parseEther('15'));
	});

	it('Should use 1/2 of moneyline market cap only if smaller than capPerSportAndType', async () => {
		const moneylineMarketCap = ethers.parseEther('40'); // → 20
		await sportsAMMV2RiskManager.setCapsPerMarket([GAME_ID_1], [0], [0], [0], [moneylineMarketCap]);

		// Set capPerSportAndType HIGH → moneyline cap applies
		await sportsAMMV2RiskManager.setCapsPerSportAndType(
			[SPORT_ID_NBA],
			[TYPE_ID_TOTAL],
			[ethers.parseEther('25')]
		);

		let cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
			GAME_ID_1,
			SPORT_ID_NBA,
			TYPE_ID_TOTAL,
			0,
			TOTAL_LINE,
			maturity,
			false
		);
		expect(cap).to.equal(ethers.parseEther('20')); // ✅ moneyline cap wins

		// Set capPerSportAndType LOW → sport/type cap applies
		await sportsAMMV2RiskManager.setCapsPerSportAndType(
			[SPORT_ID_NBA],
			[TYPE_ID_TOTAL],
			[ethers.parseEther('9')]
		);

		cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
			GAME_ID_1,
			SPORT_ID_NBA,
			TYPE_ID_TOTAL,
			0,
			TOTAL_LINE,
			maturity,
			false
		);
		expect(cap).to.equal(ethers.parseEther('9')); // ✅ capPerSportAndType wins
	});

	it('Should fallback to capPerSportAndType if no moneyline market cap is set', async () => {
		await sportsAMMV2RiskManager.setCapsPerMarket([GAME_ID_1], [0], [0], [0], [0]);
		await sportsAMMV2RiskManager.setCapsPerSportAndType(
			[SPORT_ID_NBA],
			[TYPE_ID_TOTAL],
			[ethers.parseEther('12')]
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

		expect(cap).to.equal(ethers.parseEther('12'));
	});

	it('Should fallback to capPerSportChild if capPerSportAndType is zero', async () => {
		await sportsAMMV2RiskManager.setCapsPerMarket([GAME_ID_1], [0], [0], [0], [0]);
		await sportsAMMV2RiskManager.setCapsPerSportAndType([SPORT_ID_NBA], [TYPE_ID_TOTAL], [0]);
		await sportsAMMV2RiskManager.setCapsPerSportChild([SPORT_ID_NBA], [ethers.parseEther('18')]);

		const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
			GAME_ID_1,
			SPORT_ID_NBA,
			TYPE_ID_TOTAL,
			0,
			TOTAL_LINE,
			maturity,
			false
		);

		expect(cap).to.equal(ethers.parseEther('18'));
	});

	it('Should fallback to capPerSport / 2 if no other caps are set', async () => {
		await sportsAMMV2RiskManager.setCapsPerMarket([GAME_ID_1], [0], [0], [0], [0]);
		await sportsAMMV2RiskManager.setCapsPerSportAndType([SPORT_ID_NBA], [TYPE_ID_TOTAL], [0]);
		await sportsAMMV2RiskManager.setCapsPerSportChild([SPORT_ID_NBA], [0]);
		await sportsAMMV2RiskManager.setCapsPerSport([SPORT_ID_NBA], [ethers.parseEther('30')]);

		const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
			GAME_ID_1,
			SPORT_ID_NBA,
			TYPE_ID_SPREAD,
			0,
			0,
			maturity,
			false
		);

		expect(cap).to.equal(ethers.parseEther('15'));
	});

	it('Should return 0 for past maturity', async () => {
		const pastMaturity = (await time.latest()) - 10;

		const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
			GAME_ID_1,
			SPORT_ID_NBA,
			TYPE_ID_TOTAL,
			0,
			TOTAL_LINE,
			pastMaturity,
			false
		);

		expect(cap).to.equal(0);
	});
});
