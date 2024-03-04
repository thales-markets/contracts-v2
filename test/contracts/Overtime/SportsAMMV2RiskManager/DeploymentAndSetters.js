const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { ZERO_ADDRESS, ONE_DAY_IN_SECS } = require('../../../constants/general');
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
	TOTAL_LINE,
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
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
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
						[PLAYER_PROPS_LINE_1],
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
					[PLAYER_PROPS_LINE_1],
					invalidCap
				)
			).to.be.revertedWith('Invalid cap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapPerGame(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[CHILD_ID_PLAYER_PROPS],
				[PLAYER_PROPS_ID_POINTS],
				[PLAYER_ID_1],
				[PLAYER_PROPS_LINE_1],
				newCapForGame
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerGame(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(newCapForGame);

			await expect(
				sportsAMMV2RiskManager.setCapPerGame(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[CHILD_ID_PLAYER_PROPS],
					[PLAYER_PROPS_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
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
					PLAYER_PROPS_LINE_1,
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
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
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
						[PLAYER_PROPS_LINE_1],
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
					[PLAYER_PROPS_LINE_1],
					invalidRiskMultiplier
				)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManagerWithSecondAccount.setRiskMultiplierPerGame(
				[GAME_ID_1],
				[SPORT_ID_NBA],
				[CHILD_ID_PLAYER_PROPS],
				[PLAYER_PROPS_ID_POINTS],
				[PLAYER_ID_1],
				[PLAYER_PROPS_LINE_1],
				newRiskMultiplierForGame
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerGame(
					GAME_ID_1,
					SPORT_ID_NBA,
					CHILD_ID_PLAYER_PROPS,
					PLAYER_PROPS_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(newRiskMultiplierForGame);

			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerGame(
					[GAME_ID_1],
					[SPORT_ID_NBA],
					[CHILD_ID_PLAYER_PROPS],
					[PLAYER_PROPS_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
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
					PLAYER_PROPS_LINE_1,
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
});
