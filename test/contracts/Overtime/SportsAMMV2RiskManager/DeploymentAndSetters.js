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
	let sportsAMMV2RiskManager,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		sportsAMMV2,
		owner,
		secondAccount,
		thirdAccount;

	const {
		invalidCap,
		newDefaultCap,
		invalidMaxCap,
		newMaxCap,
		newCapForSport,
		newCapForSportChild,
		newCapForSportAndType,
		newCapForMarket,
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
		({ sportsAMMV2RiskManager, sportsAMMV2Manager, sportsAMMV2ResultManager, sportsAMMV2, owner } =
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

		it('Should set the ticket params', async () => {
			expect(await sportsAMMV2RiskManager.minBuyInAmount()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.minBuyInAmount
			);
			expect(await sportsAMMV2RiskManager.maxTicketSize()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.maxTicketSize
			);
			expect(await sportsAMMV2RiskManager.maxSupportedAmount()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.maxSupportedAmount
			);
			expect(await sportsAMMV2RiskManager.maxSupportedOdds()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.maxSupportedOdds
			);
		});

		it('Should set the right times', async () => {
			expect(await sportsAMMV2RiskManager.minimalTimeLeftToMaturity()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.minimalTimeLeftToMaturity
			);
			expect(await sportsAMMV2RiskManager.expiryDuration()).to.equal(
				RISK_MANAGER_INITAL_PARAMS.expiryDuration
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new addresses (manager, resultManager, sportsAMM)', async () => {
			const newManager = await thirdAccount.getAddress();
			const newResultManager = await secondAccount.getAddress();
			const newSportsAMM = newManager; // reusing thirdAccount just for simplicity

			// Non-owner should be blocked
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setAddresses(newManager, newResultManager, newSportsAMM)
			).to.be.revertedWith('Only the contract owner may perform this action');

			// Revert if any address is zero
			await expect(
				sportsAMMV2RiskManager.setAddresses(ZERO_ADDRESS, newResultManager, newSportsAMM)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidAddress');
			await expect(
				sportsAMMV2RiskManager.setAddresses(newManager, ZERO_ADDRESS, newSportsAMM)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidAddress');
			await expect(
				sportsAMMV2RiskManager.setAddresses(newManager, newResultManager, ZERO_ADDRESS)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidAddress');

			// Perform valid update
			await expect(sportsAMMV2RiskManager.setAddresses(newManager, newResultManager, newSportsAMM))
				.to.emit(sportsAMMV2RiskManager, 'SetAddresses')
				.withArgs(newManager, newResultManager, newSportsAMM);

			// Check state
			expect(await sportsAMMV2RiskManager.manager()).to.equal(newManager);
			expect(await sportsAMMV2RiskManager.resultManager()).to.equal(newResultManager);
			expect(await sportsAMMV2RiskManager.sportsAMM()).to.equal(newSportsAMM);
		});

		it('Should set the new max cap and max risk multiplier', async () => {
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setMaxCapAndMaxRiskMultiplier(newMaxCap, newMaxRiskMultiplier)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setMaxCapAndMaxRiskMultiplier(
					invalidMaxCap,
					invalidMaxRiskMultiplier
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidInput');

			await sportsAMMV2RiskManager.setMaxCapAndMaxRiskMultiplier(newMaxCap, newMaxRiskMultiplier);
			expect(await sportsAMMV2RiskManager.maxCap()).to.equal(newMaxCap);
			expect(await sportsAMMV2RiskManager.maxRiskMultiplier()).to.equal(newMaxRiskMultiplier);

			await expect(
				sportsAMMV2RiskManager.setMaxCapAndMaxRiskMultiplier(newMaxCap, newMaxRiskMultiplier)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetMaxCapAndMaxRiskMultiplier')
				.withArgs(newMaxCap, newMaxRiskMultiplier);
		});

		it('Should set the new default cap and default risk multiplier', async () => {
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setDefaultCapAndDefaultRiskMultiplier(newDefaultCap, newDefaultRiskMultiplier)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
					invalidCap,
					invalidRiskMultiplier
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidInput');

			await sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
				newDefaultCap,
				newDefaultRiskMultiplier
			);
			expect(await sportsAMMV2RiskManager.defaultCap()).to.equal(newDefaultCap);
			expect(await sportsAMMV2RiskManager.defaultRiskMultiplier()).to.equal(
				newDefaultRiskMultiplier
			);

			await expect(
				sportsAMMV2RiskManager.setDefaultCapAndDefaultRiskMultiplier(
					newDefaultCap,
					newDefaultRiskMultiplier
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetDefaultCapAndDefaultRiskMultiplier')
				.withArgs(newDefaultCap, newDefaultRiskMultiplier);
		});

		it('Should set the new ticket params', async () => {
			const minBuyInAmount = ethers.parseEther('5');
			const maxTicketSize = 15;
			const maxSupportedAmount = ethers.parseEther('30000');
			const maxSupportedOdds = ethers.parseEther('0.001');
			const maxAllowedSystemCombinations = 500;

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setTicketParams(
						minBuyInAmount,
						maxTicketSize,
						maxSupportedAmount,
						maxSupportedOdds,
						maxAllowedSystemCombinations
					)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2RiskManager.setTicketParams(
				minBuyInAmount,
				maxTicketSize,
				maxSupportedAmount,
				maxSupportedOdds,
				maxAllowedSystemCombinations
			);
			expect(await sportsAMMV2RiskManager.minBuyInAmount()).to.equal(minBuyInAmount);
			expect(await sportsAMMV2RiskManager.maxTicketSize()).to.equal(maxTicketSize);
			expect(await sportsAMMV2RiskManager.maxSupportedAmount()).to.equal(maxSupportedAmount);
			expect(await sportsAMMV2RiskManager.maxSupportedOdds()).to.equal(maxSupportedOdds);
			expect(await sportsAMMV2RiskManager.maxAllowedSystemCombinations()).to.equal(
				maxAllowedSystemCombinations
			);

			await expect(
				sportsAMMV2RiskManager.setTicketParams(
					minBuyInAmount,
					maxTicketSize,
					maxSupportedAmount,
					maxSupportedOdds,
					maxAllowedSystemCombinations
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'TicketParamsUpdated')
				.withArgs(
					minBuyInAmount,
					maxTicketSize,
					maxSupportedAmount,
					maxSupportedOdds,
					maxAllowedSystemCombinations
				);
		});

		it('Should set the new times', async () => {
			const minimalTimeLeftToMaturity = 20;
			const expiryDuration = 15552000;

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setTimes(minimalTimeLeftToMaturity, expiryDuration)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2RiskManager.setTimes(minimalTimeLeftToMaturity, expiryDuration);
			expect(await sportsAMMV2RiskManager.minimalTimeLeftToMaturity()).to.equal(
				minimalTimeLeftToMaturity
			);
			expect(await sportsAMMV2RiskManager.expiryDuration()).to.equal(expiryDuration);

			await expect(sportsAMMV2RiskManager.setTimes(minimalTimeLeftToMaturity, expiryDuration))
				.to.emit(sportsAMMV2RiskManager, 'TimesUpdated')
				.withArgs(minimalTimeLeftToMaturity, expiryDuration);
		});

		it('Should set the new cap per sport (NBA)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSport(SPORT_ID_NBA)).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSport([SPORT_ID_NBA], [newCapForSport])
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportChild([SPORT_ID_NBA], [invalidCap])
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidCap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSport(
				[SPORT_ID_NBA],
				[newCapForSport]
			);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSport(SPORT_ID_NBA)).to.equal(
				newCapForSport
			);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSport([SPORT_ID_NBA], [newCapForSport])
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForSport);
		});

		it('Should set the new cap per sport child (NBA)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSportChild(SPORT_ID_NBA)).to.equal(
				0
			);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount
					.connect(secondAccount)
					.setCapsPerSportChild([SPORT_ID_NBA], [newCapForSportChild])
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportChild([SPORT_ID_NBA], [invalidCap])
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidCap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportChild(
				[SPORT_ID_NBA],
				[newCapForSportChild]
			);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSportChild(SPORT_ID_NBA)).to.equal(
				newCapForSportChild
			);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportChild(
					[SPORT_ID_NBA],
					[newCapForSportChild]
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSportChild')
				.withArgs(SPORT_ID_NBA, newCapForSportChild);
		});

		it('Should set the new cap per sport and type (NBA, TOTAL)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerSportAndType(
					SPORT_ID_NBA,
					TYPE_ID_TOTAL
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportAndType(
					[SPORT_ID_NBA],
					[TYPE_ID_TOTAL],
					[newCapForSportAndType]
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportAndType(
					[SPORT_ID_NBA],
					[TYPE_ID_TOTAL],
					[invalidCap]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'InvalidCap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportAndType(
				[SPORT_ID_NBA],
				[TYPE_ID_TOTAL],
				[newCapForSportAndType]
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerSportAndType(
					SPORT_ID_NBA,
					TYPE_ID_TOTAL
				)
			).to.equal(newCapForSportAndType);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerSportAndType(
					[SPORT_ID_NBA],
					[TYPE_ID_TOTAL],
					[newCapForSportAndType]
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSportAndType')
				.withArgs(SPORT_ID_NBA, TYPE_ID_TOTAL, newCapForSportAndType);
		});

		it('Should set the new cap per market (Giannis Antetokounmpo - points 33.5)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerMarket(
					GAME_ID_1,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerMarket(
					[GAME_ID_1],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					[newCapForMarket]
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerMarket(
					[GAME_ID_1],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					[invalidCap]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManagerWithSecondAccount, 'InvalidCap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCapsPerMarket(
				[GAME_ID_1],
				[TYPE_ID_POINTS],
				[PLAYER_ID_1],
				[PLAYER_PROPS_LINE_1],
				[newCapForMarket]
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerMarket(
					GAME_ID_1,
					TYPE_ID_POINTS,
					PLAYER_ID_1,
					PLAYER_PROPS_LINE_1
				)
			).to.equal(newCapForMarket);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCapsPerMarket(
					[GAME_ID_1],
					[TYPE_ID_POINTS],
					[PLAYER_ID_1],
					[PLAYER_PROPS_LINE_1],
					[newCapForMarket]
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerMarket')
				.withArgs(GAME_ID_1, TYPE_ID_POINTS, PLAYER_ID_1, PLAYER_PROPS_LINE_1, newCapForMarket);
		});

		it('Should set the new caps - batch ([NBA, EPL], [TOTAL, TOTAL])', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSport(SPORT_ID_NBA)).to.equal(0);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSport(SPORT_ID_EPL)).to.equal(0);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerSportAndType(
					SPORT_ID_NBA,
					TYPE_ID_TOTAL
				)
			).to.equal(0);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerSportAndType(
					SPORT_ID_EPL,
					TYPE_ID_TOTAL
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSportChild, newCapForSportChild],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, invalidCap],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSportChild, newCapForSportChild],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManagerWithSecondAccount, 'InvalidCap');
			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[invalidCap, newCapForSportChild],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManagerWithSecondAccount, 'InvalidCap');
			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSportChild, newCapForSportChild],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[invalidCap, newCapForSportAndType]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManagerWithSecondAccount, 'InvalidCap');

			await sportsAMMV2RiskManagerWithSecondAccount.setCaps(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newCapForSport, newCapForSport],
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newCapForSportChild, newCapForSportChild],
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
				[newCapForSportAndType, newCapForSportAndType]
			);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSport(SPORT_ID_NBA)).to.equal(
				newCapForSport
			);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSport(SPORT_ID_EPL)).to.equal(
				newCapForSport
			);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSportChild(SPORT_ID_NBA)).to.equal(
				newCapForSportChild
			);
			expect(await sportsAMMV2RiskManagerWithSecondAccount.capPerSportChild(SPORT_ID_EPL)).to.equal(
				newCapForSportChild
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerSportAndType(
					SPORT_ID_NBA,
					TYPE_ID_TOTAL
				)
			).to.equal(newCapForSportAndType);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.capPerSportAndType(
					SPORT_ID_EPL,
					TYPE_ID_TOTAL
				)
			).to.equal(newCapForSportAndType);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSport, newCapForSport],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForSportChild, newCapForSportChild],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[TYPE_ID_TOTAL, TYPE_ID_TOTAL],
					[newCapForSportAndType, newCapForSportAndType]
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForSport)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSport')
				.withArgs(SPORT_ID_EPL, newCapForSport)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSportChild')
				.withArgs(SPORT_ID_NBA, newCapForSportChild)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSportChild')
				.withArgs(SPORT_ID_EPL, newCapForSportChild)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSportAndType')
				.withArgs(SPORT_ID_NBA, TYPE_ID_TOTAL, newCapForSportAndType)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetCapPerSportAndType')
				.withArgs(SPORT_ID_EPL, TYPE_ID_TOTAL, newCapForSportAndType);
		});

		it('Should set the new risk multiplier per sport (NBA)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerSport(SPORT_ID_NBA)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
					[SPORT_ID_NBA],
					[newRiskMultiplierForSport]
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
					[SPORT_ID_NBA],
					[invalidRiskMultiplier]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'MultiplierTooHigh');

			await sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
				[SPORT_ID_NBA],
				[newRiskMultiplierForSport]
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerSport(SPORT_ID_NBA)
			).to.equal(newRiskMultiplierForSport);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
					[SPORT_ID_NBA],
					[newRiskMultiplierForSport]
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_NBA, newRiskMultiplierForSport);
		});

		it('Should set the new risk multiplier per game (Milwaukee Bucks vs Indiana Pacers)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerGame(GAME_ID_1)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerGame(
					[GAME_ID_1],
					[newRiskMultiplierForGame]
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerGame(
					[GAME_ID_1],
					[invalidRiskMultiplier]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'MultiplierTooHigh');

			await sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerGame(
				[GAME_ID_1],
				[newRiskMultiplierForGame]
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerGame(GAME_ID_1)
			).to.equal(newRiskMultiplierForGame);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerGame(
					[GAME_ID_1],
					[newRiskMultiplierForGame]
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetRiskMultiplierPerGame')
				.withArgs(GAME_ID_1, newRiskMultiplierForGame);
		});

		it('Should set the new risk multipliers - batch ([NBA, EPL])', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerSport(SPORT_ID_NBA)
			).to.equal(0);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerSport(SPORT_ID_EPL)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newRiskMultiplierForSport, newRiskMultiplierForSport]
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[invalidRiskMultiplier, newRiskMultiplierForSport]
				)
			).to.be.revertedWithCustomError(sportsAMMV2RiskManager, 'MultiplierTooHigh');

			await sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newRiskMultiplierForSport, newRiskMultiplierForSport]
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerSport(SPORT_ID_NBA)
			).to.equal(newRiskMultiplierForSport);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.riskMultiplierPerSport(SPORT_ID_EPL)
			).to.equal(newRiskMultiplierForSport);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultipliersPerSport(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newRiskMultiplierForSport, newRiskMultiplierForSport]
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_NBA, newRiskMultiplierForSport)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_EPL, newRiskMultiplierForSport);
		});

		it('Should set the new dynamic liquidity params per sport (NBA)', async () => {
			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.dynamicLiquidityCutoffTimePerSport(
					SPORT_ID_NBA
				)
			).to.equal(0);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.dynamicLiquidityCutoffDividerPerSport(
					SPORT_ID_NBA
				)
			).to.equal(0);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setDynamicLiquidityParamsPerSport(
					SPORT_ID_NBA,
					newDynamicLiquidityCutoffTime,
					newDynamicLiquidityCutoffDivider
				)
			).to.be.revertedWith('InvalidSender');

			await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 1, true);

			await sportsAMMV2RiskManagerWithSecondAccount.setDynamicLiquidityParamsPerSport(
				SPORT_ID_NBA,
				newDynamicLiquidityCutoffTime,
				newDynamicLiquidityCutoffTime
			);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.dynamicLiquidityCutoffTimePerSport(
					SPORT_ID_NBA
				)
			).to.equal(newDynamicLiquidityCutoffTime);
			expect(
				await sportsAMMV2RiskManagerWithSecondAccount.dynamicLiquidityCutoffDividerPerSport(
					SPORT_ID_NBA
				)
			).to.equal(newDynamicLiquidityCutoffTime);

			await expect(
				sportsAMMV2RiskManagerWithSecondAccount.setDynamicLiquidityParamsPerSport(
					SPORT_ID_NBA,
					newDynamicLiquidityCutoffTime,
					newDynamicLiquidityCutoffDivider
				)
			)
				.to.emit(sportsAMMV2RiskManagerWithSecondAccount, 'SetDynamicLiquidityParams')
				.withArgs(SPORT_ID_NBA, newDynamicLiquidityCutoffTime, newDynamicLiquidityCutoffDivider);
		});
	});
});
