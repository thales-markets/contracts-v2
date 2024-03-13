const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS } = require('../../../constants/general');
const {
	INVALID_SPORT_ID,
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	INVALID_TYPE_ID,
	TYPE_ID_TOTAL,
	TYPE_ID_POINTS,
	GAME_ID_1,
	PLAYER_ID_1,
	PLAYER_PROPS_LINE_1,
} = require('../../../constants/overtime');
const {
	RISK_MANAGER_PARAMS,
	RISK_MANAGER_INITAL_PARAMS,
} = require('../../../constants/overtimeContractParams');

describe('SportsAMMV2RiskManager Deployment And Setters', () => {
	let sportsAMMV2RiskManager, sportsAMMV2Manager, owner, secondAccount, thirdAccount;

	const {
		invalidCap,
		newDefaultCap,
		invalidMaxCap,
		newMaxCap,
		newCapForSport,
		newCapForSportAndType,
		newCapForMarket,
		invalidRiskMultiplier,
		newDefaultRiskMultiplier,
		invalidMaxRiskMultiplier,
		newMaxRiskMultiplier,
		newRiskMultiplierForSport,
		newRiskMultiplierForMarket,
		newDynamicLiquidityCutoffTime,
		newDynamicLiquidityCutoffDivider,
	} = RISK_MANAGER_PARAMS;

	beforeEach(async () => {
		({ sportsAMMV2RiskManager, sportsAMMV2Manager, owner } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2RiskManager.owner()).to.equal(owner.address);
		});

		it('Should set the right manager', async () => {
			expect(await sportsAMMV2RiskManager.manager()).to.equal(
				await sportsAMMV2Manager.getAddress()
			);
		});

		it('Should set the right default cap', async () => {
			expect(await sportsAMMV2RiskManager.defaultCap()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.defaultCap
			);
		});

		it('Should set the right default risk multiplier', async () => {
			expect(await sportsAMMV2RiskManager.defaultRiskMultiplier()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.defaultRiskMultiplier
			);
		});

		it('Should set the right max cap', async () => {
			expect(await sportsAMMV2RiskManager.maxCap()).to.equal(RISK_MANAGER_INITAL_PARAMS.maxCap);
		});

		it('Should set the right max risk multiplier', async () => {
			expect(await sportsAMMV2RiskManager.maxRiskMultiplier()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.maxRiskMultiplier
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new manager', async () => {
			await expect(
				sportsAMMV2RiskManager.connect(secondAccount).setSportsManager(thirdAccount)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(sportsAMMV2RiskManager.setSportsManager(ZERO_ADDRESS)).to.be.revertedWith(
				'Invalid address'
			);

			await sportsAMMV2RiskManager.setSportsManager(thirdAccount);
			expect(await sportsAMMV2RiskManager.manager()).to.equal(thirdAccount.address);

			await expect(sportsAMMV2RiskManager.setSportsManager(thirdAccount))
				.to.emit(sportsAMMV2RiskManager, 'SetSportsManager')
				.withArgs(thirdAccount.address);
		});

		it('Should set the new default cap', async () => {
			await expect(
				sportsAMMV2RiskManager.connect(secondAccount).setDefaultCap(newDefaultCap)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(sportsAMMV2RiskManager.setDefaultCap(invalidCap)).to.be.revertedWith(
				'Invalid cap'
			);

			await sportsAMMV2RiskManager.setDefaultCap(newDefaultCap);
			expect(await sportsAMMV2RiskManager.defaultCap()).to.equal(newDefaultCap);

			await expect(sportsAMMV2RiskManager.setDefaultCap(newDefaultCap))
				.to.emit(sportsAMMV2RiskManager, 'SetDefaultCap')
				.withArgs(newDefaultCap);
		});

		it('Should set the new default risk multiplier', async () => {
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setDefaultRiskMultiplier(newDefaultRiskMultiplier)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setDefaultRiskMultiplier(invalidRiskMultiplier)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManager.setDefaultRiskMultiplier(newDefaultRiskMultiplier);
			expect(await sportsAMMV2RiskManager.defaultRiskMultiplier()).to.equal(
				newDefaultRiskMultiplier
			);

			await expect(sportsAMMV2RiskManager.setDefaultRiskMultiplier(newDefaultRiskMultiplier))
				.to.emit(sportsAMMV2RiskManager, 'SetDefaultRiskMultiplier')
				.withArgs(newDefaultRiskMultiplier);
		});

		it('Should set the new max cap and max risk multiplier', async () => {
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setMaxCapAndRisk(invalidMaxCap, invalidMaxRiskMultiplier)
			).to.be.revertedWith('Invalid input');

			await sportsAMMV2RiskManager.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier);
			expect(await sportsAMMV2RiskManager.maxCap()).to.equal(newMaxCap);
			expect(await sportsAMMV2RiskManager.maxRiskMultiplier()).to.equal(newMaxRiskMultiplier);

			await expect(sportsAMMV2RiskManager.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier))
				.to.emit(sportsAMMV2RiskManager, 'SetMaxCapAndRisk')
				.withArgs(newMaxCap, newMaxRiskMultiplier);
		});

		it('Should set the new cap per sport (NBA)', async () => {
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(0);

			await expect(
				sportsAMMV2RiskManager.connect(secondAccount).setCapPerSport(SPORT_ID_NBA, newCapForSport)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCapPerSport(INVALID_SPORT_ID, newCapForSport)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, invalidCap)
			).to.be.revertedWith('Invalid cap');

			await sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForSport);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(newCapForSport);

			await expect(sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForSport))
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForSport);
		});

		it('Should set the new cap per sport and type (NBA, TOTAL)', async () => {
			expect(await sportsAMMV2RiskManager.capPerSportAndType(SPORT_ID_NBA, TYPE_ID_TOTAL)).to.equal(
				0
			);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCapPerSportAndType(SPORT_ID_NBA, TYPE_ID_TOTAL, newCapForSportAndType)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndType(SPORT_ID_NBA, TYPE_ID_TOTAL, invalidCap)
			).to.be.revertedWith('Invalid cap');

			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndType(
					INVALID_SPORT_ID,
					TYPE_ID_TOTAL,
					newCapForSportAndType
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndType(
					SPORT_ID_NBA,
					INVALID_TYPE_ID,
					newCapForSportAndType
				)
			).to.be.revertedWith('Invalid ID for type');

			await sportsAMMV2RiskManager.setCapPerSportAndType(
				SPORT_ID_NBA,
				TYPE_ID_TOTAL,
				newCapForSportAndType
			);
			expect(await sportsAMMV2RiskManager.capPerSportAndType(SPORT_ID_NBA, TYPE_ID_TOTAL)).to.equal(
				newCapForSportAndType
			);

			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndType(
					SPORT_ID_NBA,
					TYPE_ID_TOTAL,
					newCapForSportAndType
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndType')
				.withArgs(SPORT_ID_NBA, TYPE_ID_TOTAL, newCapForSportAndType);
		});

		it('Should set the new cap per market (Giannis Antetokounmpo - points 33.5)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerMarket(
					GAME_ID_1,
					SPORT_ID_NBA,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCapPerMarket(
						[GAME_ID_1],
						[SPORT_ID_NBA],
						[TYPE_ID_POINTS],
						[PLAYER_ID_1],
						[PLAYER_PROPS_LINE_1],
						newCapForMarket
					)
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapPerMarket(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					invalidCap
				)
			).to.be.revertedWith('Invalid cap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapPerMarket(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[TYPE_ID_POINTS],
				[PLAYER_ID_1],
				[PLAYER_PROPS_LINE_1],
				newCapForMarket
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerMarket(
					GAME_ID_1,
					SPORT_ID_NBA,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(newCapForMarket);

			await expect(
				sportsAMMV2RiskManager.setCapPerMarket(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					newCapForMarket
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerMarket')
				.withArgs(
					GAME_ID_1,
					SPORT_ID_NBA,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1,
					newCapForMarket
				);
		});

		it('Should set the new caps - batch ([NBA, EPL], [TOTAL, TOTAL])', async () => {
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(0);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_EPL)).to.equal(0);
			expect(await sportsAMMV2RiskManager.capPerSportAndType(SPORT_ID_NBA, TYPE_ID_TOTAL)).to.equal(
				0
			);
			expect(await sportsAMMV2RiskManager.capPerSportAndType(SPORT_ID_EPL, TYPE_ID_TOTAL)).to.equal(
				0
			);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCaps(
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[newCapForSport, newCapForSport],
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
						[newCapForSportAndType, newCapForSportAndType]
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, invalidCap],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWith('Invalid cap');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[invalidCap, newCapForSportAndType]
				)
			).to.be.revertedWith('Invalid cap');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[INVALID_SPORT_ID, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, INVALID_SPORT_ID],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, INVALID_TYPE_ID],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWith('Invalid ID for type');

			await sportsAMMV2RiskManager.setCaps(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newCapForSport, newCapForSport],
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
				[newCapForSportAndType, newCapForSportAndType]
			);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(newCapForSport);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_EPL)).to.equal(newCapForSport);
			expect(await sportsAMMV2RiskManager.capPerSportAndType(SPORT_ID_NBA, TYPE_ID_TOTAL)).to.equal(
				newCapForSportAndType
			);
			expect(await sportsAMMV2RiskManager.capPerSportAndType(SPORT_ID_EPL, TYPE_ID_TOTAL)).to.equal(
				newCapForSportAndType
			);

			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForSport)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_EPL, newCapForSport)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndType')
				.withArgs(SPORT_ID_NBA, TYPE_ID_TOTAL, newCapForSportAndType)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndType')
				.withArgs(SPORT_ID_EPL, TYPE_ID_TOTAL, newCapForSportAndType);
		});

		it('Should set the new risk multiplier per sport (NBA)', async () => {
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_NBA)).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setRiskMultiplierPerSport(SPORT_ID_NBA, newRiskMultiplierForSport)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerSport(
					INVALID_SPORT_ID,
					newRiskMultiplierForSport
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerSport(SPORT_ID_NBA, invalidRiskMultiplier)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManager.setRiskMultiplierPerSport(
				SPORT_ID_NBA,
				newRiskMultiplierForSport
			);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_NBA)).to.equal(
				newRiskMultiplierForSport
			);

			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerSport(SPORT_ID_NBA, newRiskMultiplierForSport)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_NBA, newRiskMultiplierForSport);
		});

		it('Should set the new risk multiplier per market (Giannis Antetokounmpo - points 33.5)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerMarket(
					GAME_ID_1,
					SPORT_ID_NBA,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setRiskMultiplierPerMarket(
						[GAME_ID_1],
						[SPORT_ID_NBA],
						[TYPE_ID_POINTS],
						[PLAYER_ID_1],
						[PLAYER_PROPS_LINE_1],
						newRiskMultiplierForMarket
					)
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultiplierPerMarket(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					invalidRiskMultiplier
				)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManagerWithSecondAccount.setRiskMultiplierPerMarket(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[TYPE_ID_POINTS],
				[PLAYER_ID_1],
				[PLAYER_PROPS_LINE_1],
				newRiskMultiplierForMarket
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerMarket(
					GAME_ID_1,
					SPORT_ID_NBA,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(newRiskMultiplierForMarket);

			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerMarket(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					newRiskMultiplierForMarket
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerMarket')
				.withArgs(
					GAME_ID_1,
					SPORT_ID_NBA,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1,
					newRiskMultiplierForMarket
				);
		});

		it('Should set the new risk multipliers - batch ([NBA, EPL])', async () => {
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_NBA)).to.equal(0);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_EPL)).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setRiskMultipliers(
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[newRiskMultiplierForSport, newRiskMultiplierForSport]
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setRiskMultipliers(
					[INVALID_SPORT_ID, SPORT_ID_EPL],
					[newRiskMultiplierForSport, newRiskMultiplierForSport]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setRiskMultipliers(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[invalidRiskMultiplier, newRiskMultiplierForSport]
				)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManager.setRiskMultipliers(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newRiskMultiplierForSport, newRiskMultiplierForSport]
			);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_NBA)).to.equal(
				newRiskMultiplierForSport
			);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_EPL)).to.equal(
				newRiskMultiplierForSport
			);

			await expect(
				sportsAMMV2RiskManager.setRiskMultipliers(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newRiskMultiplierForSport, newRiskMultiplierForSport]
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_NBA, newRiskMultiplierForSport)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_EPL, newRiskMultiplierForSport);
		});

		it('Should set the new dynamic liquidity params per sport (NBA)', async () => {
			expect(
				await sportsAMMV2RiskManager.dynamicLiquidityCutoffTimePerSport(SPORT_ID_NBA)
			).to.equal(0);
			expect(
				await sportsAMMV2RiskManager.dynamicLiquidityCutoffDividerPerSport(SPORT_ID_NBA)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setDynamicLiquidityParamsPerSport(
						SPORT_ID_NBA,
						newDynamicLiquidityCutoffTime,
						newDynamicLiquidityCutoffDivider
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(
					INVALID_SPORT_ID,
					newDynamicLiquidityCutoffTime,
					newDynamicLiquidityCutoffDivider
				)
			).to.be.revertedWith('Invalid ID for sport');

			await sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(
				SPORT_ID_NBA,
				newDynamicLiquidityCutoffTime,
				newDynamicLiquidityCutoffTime
			);
			expect(
				await sportsAMMV2RiskManager.dynamicLiquidityCutoffTimePerSport(SPORT_ID_NBA)
			).to.equal(newDynamicLiquidityCutoffTime);
			expect(
				await sportsAMMV2RiskManager.dynamicLiquidityCutoffDividerPerSport(SPORT_ID_NBA)
			).to.equal(newDynamicLiquidityCutoffTime);

			await expect(
				sportsAMMV2RiskManager.setDynamicLiquidityParamsPerSport(
					SPORT_ID_NBA,
					newDynamicLiquidityCutoffTime,
					newDynamicLiquidityCutoffDivider
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetDynamicLiquidityParams')
				.withArgs(SPORT_ID_NBA, newDynamicLiquidityCutoffTime, newDynamicLiquidityCutoffDivider);
		});
	});
});
