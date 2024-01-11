const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('./utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS, ONE_DAY_IN_SECS } = require('./constants/general');
const {
	INVALID_SPORT_ID,
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	INVALID_CHILD_ID,
	CHILD_ID_SPREAD,
	CHILD_ID_TOTAL,
	CHILD_ID_PLAYER_PROPS,
	GAME_ID_1,
	PLAYER_PROPS_ID_POINTS,
	PLAYER_ID_1,
} = require('./constants/overtime');
const {
	RISK_MANAGER_PARAMS,
	RISK_MANAGER_INITAL_PARAMS,
} = require('./constants/overtimeContractParams');

describe('SportsAMMV2RiskManager', () => {
	let sportsAMMV2RiskManager, sportsAMMV2Manager, owner, secondAccount, thirdAccount;

	const {
		invalidCap,
		newDefaultCap,
		invalidMaxCap,
		newMaxCap,
		newCapForSport,
		newCapForSportAndChild,
		newCapForGame,
		invalidRiskMultiplier,
		newDefaultRiskMultiplier,
		invalidMaxRiskMultiplier,
		newMaxRiskMultiplier,
		newRiskMultiplierForSport,
		newRiskMultiplierForGame,
		newDynamicLiquidityCutoffTime,
		newDynamicLiquidityCutoffDivider,
	} = RISK_MANAGER_PARAMS;

	beforeEach(async () => {
		const sportsAMMV2ManagerFixture = await loadFixture(deploySportsAMMV2Fixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		sportsAMMV2RiskManager = sportsAMMV2ManagerFixture.sportsAMMV2RiskManager;
		sportsAMMV2Manager = sportsAMMV2ManagerFixture.sportsAMMV2Manager;
		owner = sportsAMMV2ManagerFixture.owner;

		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
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

		it('Should set the new cap per sport and child (NBA, TOTAL)', async () => {
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCapPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL, newCapForSportAndChild)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL, invalidCap)
			).to.be.revertedWith('Invalid cap');

			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					INVALID_SPORT_ID,
					CHILD_ID_TOTAL,
					newCapForSportAndChild
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					SPORT_ID_NBA,
					INVALID_CHILD_ID,
					newCapForSportAndChild
				)
			).to.be.revertedWith('Invalid ID for child');

			await sportsAMMV2RiskManager.setCapPerSportAndChild(
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				newCapForSportAndChild
			);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL)
			).to.equal(newCapForSportAndChild);

			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					SPORT_ID_NBA,
					CHILD_ID_TOTAL,
					newCapForSportAndChild
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndChild')
				.withArgs(SPORT_ID_NBA, CHILD_ID_TOTAL, newCapForSportAndChild);
		});

		it('Should set the new cap per game (Giannis Antetokounmpo - points 33.5)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerGame(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCapPerGame(
						[GAME_ID_1],
						[SPORT_ID_NBA],
						[CHILD_ID_PLAYER_PROPS],
						[PLAYER_PROPS_ID_POINTS],
						[PLAYER_ID_1],
						newCapForGame
					)
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapPerGame(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[CHILD_ID_PLAYER_PROPS],
					[PLAYER_PROPS_ID_POINTS],
					[PLAYER_ID_1],
					invalidCap
				)
			).to.be.revertedWith('Invalid cap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapPerGame(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[CHILD_ID_PLAYER_PROPS],
				[PLAYER_PROPS_ID_POINTS],
				[PLAYER_ID_1],
				newCapForGame
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerGame(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1
				)
			).to.equal(newCapForGame);

			await expect(
				sportsAMMV2RiskManager.setCapPerGame(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[CHILD_ID_PLAYER_PROPS],
					[PLAYER_PROPS_ID_POINTS],
					[PLAYER_ID_1],
					newCapForGame
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerGame')
				.withArgs(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1,
					newCapForGame
				);
		});

		it('Should set the new caps - batch ([NBA, EPL], [TOTAL, TOTAL])', async () => {
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(0);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_EPL)).to.equal(0);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL)
			).to.equal(0);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_EPL, CHILD_ID_TOTAL)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCaps(
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[newCapForSport, newCapForSport],
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
						[newCapForSportAndChild, newCapForSportAndChild]
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, invalidCap],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForSportAndChild, newCapForSportAndChild]
				)
			).to.be.revertedWith('Invalid cap');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[invalidCap, newCapForSportAndChild]
				)
			).to.be.revertedWith('Invalid cap');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[INVALID_SPORT_ID, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForSportAndChild, newCapForSportAndChild]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, INVALID_SPORT_ID],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForSportAndChild, newCapForSportAndChild]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, INVALID_CHILD_ID],
					[newCapForSportAndChild, newCapForSportAndChild]
				)
			).to.be.revertedWith('Invalid ID for child');

			await sportsAMMV2RiskManager.setCaps(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newCapForSport, newCapForSport],
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
				[newCapForSportAndChild, newCapForSportAndChild]
			);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(newCapForSport);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_EPL)).to.equal(newCapForSport);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL)
			).to.equal(newCapForSportAndChild);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_EPL, CHILD_ID_TOTAL)
			).to.equal(newCapForSportAndChild);

			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForSportAndChild, newCapForSportAndChild]
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForSport)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_EPL, newCapForSport)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndChild')
				.withArgs(SPORT_ID_NBA, CHILD_ID_TOTAL, newCapForSportAndChild)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndChild')
				.withArgs(SPORT_ID_EPL, CHILD_ID_TOTAL, newCapForSportAndChild);
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

		it('Should set the new risk multiplier per game (Giannis Antetokounmpo - points 33.5)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerGame(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setRiskMultiplierPerGame(
						[GAME_ID_1],
						[SPORT_ID_NBA],
						[CHILD_ID_PLAYER_PROPS],
						[PLAYER_PROPS_ID_POINTS],
						[PLAYER_ID_1],
						newRiskMultiplierForGame
					)
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultiplierPerGame(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[CHILD_ID_PLAYER_PROPS],
					[PLAYER_PROPS_ID_POINTS],
					[PLAYER_ID_1],
					invalidRiskMultiplier
				)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManagerWithSecondAccount.setRiskMultiplierPerGame(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[CHILD_ID_PLAYER_PROPS],
				[PLAYER_PROPS_ID_POINTS],
				[PLAYER_ID_1],
				newRiskMultiplierForGame
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerGame(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1
				)
			).to.equal(newRiskMultiplierForGame);

			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerGame(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[CHILD_ID_PLAYER_PROPS],
					[PLAYER_PROPS_ID_POINTS],
					[PLAYER_ID_1],
					newRiskMultiplierForGame
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerGame')
				.withArgs(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1,
					newRiskMultiplierForGame
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
				newCapForGame
			);

			const cap = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				GAME_ID_1,
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				0,
				0,
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
					maturity
				);

			expect(isTotalSpendingLessThanTotalRisk).to.equal(false);
		});
	});
});
