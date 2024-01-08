const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deploySportsAMMV2RiskManagerFixture,
	deployAccountsFixture,
} = require('./utils/fixtures/overtimeFixtures');
const {
	INVALID_SPORT_ID,
	SPORT_ID_NBA,
	CHILD_ID_TOTAL,
	INVALID_CHILD_ID,
	GAME_ID_1,
	CHILD_ID_PLAYER_PROPS,
	PLAYER_PROPS_ID_POINTS,
	PLAYER_ID_1,
	SPORT_ID_EPL,
	ZERO_ADDRESS,
} = require('./constants/overtime');

describe('SportsAMMV2RiskManager', function () {
	describe('Deployment', function () {
		it('Should set the right owner', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { owner } = await loadFixture(deployAccountsFixture);

			expect(await sportsAMMV2RiskManager.owner()).to.equal(owner.address);
		});

		it('Should set the right manager', async function () {
			const { sportsAMMV2RiskManager, sportsAMMV2Manager } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);

			expect(await sportsAMMV2RiskManager.manager()).to.equal(
				await sportsAMMV2Manager.getAddress()
			);
		});

		it('Should set the right default cap', async function () {
			const { sportsAMMV2RiskManager, defaultCap } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);

			expect(await sportsAMMV2RiskManager.defaultCap()).to.equal(defaultCap);
		});

		it('Should set the right default risk multiplier', async function () {
			const { sportsAMMV2RiskManager, defaultRiskMultiplier } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);

			expect(await sportsAMMV2RiskManager.defaultRiskMultiplier()).to.equal(defaultRiskMultiplier);
		});

		it('Should set the right max cap', async function () {
			const { sportsAMMV2RiskManager, maxCap } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);

			expect(await sportsAMMV2RiskManager.maxCap()).to.equal(maxCap);
		});

		it('Should set the right max risk multiplier', async function () {
			const { sportsAMMV2RiskManager, maxRiskMultiplier } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);

			expect(await sportsAMMV2RiskManager.maxRiskMultiplier()).to.equal(maxRiskMultiplier);
		});
	});

	describe('Setters - caps', function () {
		it('Should set the new manager', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture);

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

		it('Should set the new default cap', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newDefaultCap = ethers.parseEther('30000');

			await expect(
				sportsAMMV2RiskManager.connect(secondAccount).setDefaultCap(newDefaultCap)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(sportsAMMV2RiskManager.setDefaultCap(newDefaultCap)).to.be.revertedWith(
				'Invalid cap'
			);

			newDefaultCap = ethers.parseEther('10000');

			await sportsAMMV2RiskManager.setDefaultCap(newDefaultCap);
			expect(await sportsAMMV2RiskManager.defaultCap()).to.equal(newDefaultCap);

			await expect(sportsAMMV2RiskManager.setDefaultCap(newDefaultCap))
				.to.emit(sportsAMMV2RiskManager, 'SetDefaultCap')
				.withArgs(newDefaultCap);
		});

		it('Should set the new default risk multiplier', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newDefaultRiskMultiplier = 6;

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setDefaultRiskMultiplier(newDefaultRiskMultiplier)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setDefaultRiskMultiplier(newDefaultRiskMultiplier)
			).to.be.revertedWith('Invalid multiplier');

			newDefaultRiskMultiplier = 4;

			await sportsAMMV2RiskManager.setDefaultRiskMultiplier(newDefaultRiskMultiplier);
			expect(await sportsAMMV2RiskManager.defaultRiskMultiplier()).to.equal(
				newDefaultRiskMultiplier
			);

			await expect(sportsAMMV2RiskManager.setDefaultRiskMultiplier(newDefaultRiskMultiplier))
				.to.emit(sportsAMMV2RiskManager, 'SetDefaultRiskMultiplier')
				.withArgs(newDefaultRiskMultiplier);
		});

		it('Should set the new max cap and max risk multiplier', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newMaxCap = ethers.parseEther('900');
			let newMaxRiskMultiplier = 2;

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier)
			).to.be.revertedWith('Invalid input');

			newMaxCap = ethers.parseEther('2000');
			newMaxRiskMultiplier = 4;

			await sportsAMMV2RiskManager.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier);
			expect(await sportsAMMV2RiskManager.maxCap()).to.equal(newMaxCap);
			expect(await sportsAMMV2RiskManager.maxRiskMultiplier()).to.equal(newMaxRiskMultiplier);

			await expect(sportsAMMV2RiskManager.setMaxCapAndRisk(newMaxCap, newMaxRiskMultiplier))
				.to.emit(sportsAMMV2RiskManager, 'SetMaxCapAndRisk')
				.withArgs(newMaxCap, newMaxRiskMultiplier);
		});

		it('Should set the new cap per sport (NBA - ID 9004)', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newCapForNba = ethers.parseEther('30000');

			await expect(
				sportsAMMV2RiskManager.connect(secondAccount).setCapPerSport(SPORT_ID_NBA, newCapForNba)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCapPerSport(INVALID_SPORT_ID, newCapForNba)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForNba)
			).to.be.revertedWith('Invalid cap');

			newCapForNba = ethers.parseEther('10000');

			await sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForNba);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(newCapForNba);

			await expect(sportsAMMV2RiskManager.setCapPerSport(SPORT_ID_NBA, newCapForNba))
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForNba);
		});

		it('Should set the new cap per sport and child (NBA - ID 9004, TOTAL - ID 10002)', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newCapForNbaTotal = ethers.parseEther('3000');

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCapPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL, newCapForNbaTotal)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					SPORT_ID_NBA,
					CHILD_ID_TOTAL,
					newCapForNbaTotal
				)
			).to.be.revertedWith('Invalid cap');

			newCapForNbaTotal = ethers.parseEther('900');

			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					INVALID_SPORT_ID,
					CHILD_ID_TOTAL,
					newCapForNbaTotal
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					SPORT_ID_NBA,
					INVALID_CHILD_ID,
					newCapForNbaTotal
				)
			).to.be.revertedWith('Invalid ID for child');

			await sportsAMMV2RiskManager.setCapPerSportAndChild(
				SPORT_ID_NBA,
				CHILD_ID_TOTAL,
				newCapForNbaTotal
			);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL)
			).to.equal(newCapForNbaTotal);

			await expect(
				sportsAMMV2RiskManager.setCapPerSportAndChild(
					SPORT_ID_NBA,
					CHILD_ID_TOTAL,
					newCapForNbaTotal
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndChild')
				.withArgs(SPORT_ID_NBA, CHILD_ID_TOTAL, newCapForNbaTotal);
		});

		it('Should set the new cap per game (Giannis Antetokounmpo - points 33.5)', async function () {
			const { sportsAMMV2RiskManager, sportsAMMV2Manager } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newCapForGame = ethers.parseEther('30000');

			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

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
					newCapForGame
				)
			).to.be.revertedWith('Invalid cap');

			newCapForGame = ethers.parseEther('10000');

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
				sportsAMMV2RiskManagerWithSecondAccount.setCapPerGame(
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

		it('Should set the new caps - batch (NBA - ID 9004,EPL - ID 9011; TOTAL - ID 10002)', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newCapForNba = ethers.parseEther('10000');
			let newCapForEpl = ethers.parseEther('10000');

			let newCapForNbaTotal = ethers.parseEther('800');
			let newCapForEplTotal = ethers.parseEther('800');

			let invalidCap = ethers.parseEther('30000');

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setCaps(
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[newCapForNba, newCapForEpl],
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
						[newCapForNbaTotal, newCapForEplTotal]
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[invalidCap, newCapForEpl],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForNbaTotal, newCapForEplTotal]
				)
			).to.be.revertedWith('Invalid cap');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForNba, newCapForEpl],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[invalidCap, newCapForEplTotal]
				)
			).to.be.revertedWith('Invalid cap');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[INVALID_SPORT_ID, SPORT_ID_EPL],
					[newCapForNba, newCapForEpl],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForNbaTotal, newCapForEplTotal]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForNba, newCapForEpl],
					[SPORT_ID_NBA, INVALID_SPORT_ID],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForNbaTotal, newCapForEplTotal]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForNba, newCapForEpl],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, INVALID_CHILD_ID],
					[newCapForNbaTotal, newCapForEplTotal]
				)
			).to.be.revertedWith('Invalid ID for child');

			await sportsAMMV2RiskManager.setCaps(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newCapForNba, newCapForEpl],
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
				[newCapForNbaTotal, newCapForEplTotal]
			);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_NBA)).to.equal(newCapForNba);
			expect(await sportsAMMV2RiskManager.capPerSport(SPORT_ID_EPL)).to.equal(newCapForEpl);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_NBA, CHILD_ID_TOTAL)
			).to.equal(newCapForNbaTotal);
			expect(
				await sportsAMMV2RiskManager.capPerSportAndChild(SPORT_ID_EPL, CHILD_ID_TOTAL)
			).to.equal(newCapForEplTotal);

			await expect(
				sportsAMMV2RiskManager.setCaps(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newCapForNba, newCapForEpl],
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[CHILD_ID_TOTAL, CHILD_ID_TOTAL],
					[newCapForNbaTotal, newCapForEplTotal]
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_NBA, newCapForNba)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSport')
				.withArgs(SPORT_ID_EPL, newCapForEpl)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndChild')
				.withArgs(SPORT_ID_NBA, CHILD_ID_TOTAL, newCapForNbaTotal)
				.to.emit(sportsAMMV2RiskManager, 'SetCapPerSportAndChild')
				.withArgs(SPORT_ID_EPL, CHILD_ID_TOTAL, newCapForEplTotal);
		});

		it('Should set the new risk multiplier per sport (NBA - ID 9004)', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newRiskMultiplierForNba = 6;

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setRiskMultiplierPerSport(SPORT_ID_NBA, newRiskMultiplierForNba)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerSport(INVALID_SPORT_ID, newRiskMultiplierForNba)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerSport(SPORT_ID_NBA, newRiskMultiplierForNba)
			).to.be.revertedWith('Invalid multiplier');

			newRiskMultiplierForNba = 4;

			await sportsAMMV2RiskManager.setRiskMultiplierPerSport(SPORT_ID_NBA, newRiskMultiplierForNba);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_NBA)).to.equal(
				newRiskMultiplierForNba
			);

			await expect(
				sportsAMMV2RiskManager.setRiskMultiplierPerSport(SPORT_ID_NBA, newRiskMultiplierForNba)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_NBA, newRiskMultiplierForNba);
		});

		it('Should set the new risk multiplier per game (Giannis Antetokounmpo - points 33.5)', async function () {
			const { sportsAMMV2RiskManager, sportsAMMV2Manager } = await loadFixture(
				deploySportsAMMV2RiskManagerFixture
			);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newRiskMultiplierForGame = 6;

			const sportsAMMV2RiskManagerWithSecondAccount = sportsAMMV2RiskManager.connect(secondAccount);

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
					newRiskMultiplierForGame
				)
			).to.be.revertedWith('Invalid multiplier');

			newRiskMultiplierForGame = 4;

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
				sportsAMMV2RiskManagerWithSecondAccount.setRiskMultiplierPerGame(
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

		it('Should set the new risk multipliers - batch (NBA - ID 9004, EPL - ID 9011)', async function () {
			const { sportsAMMV2RiskManager } = await loadFixture(deploySportsAMMV2RiskManagerFixture);
			const { secondAccount } = await loadFixture(deployAccountsFixture);

			let newRiskMultiplierForNba = 4;
			let newRiskMultiplierForEpl = 4;

			let invalidRiskMultiplier = 6;

			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setRiskMultipliers(
						[SPORT_ID_NBA, SPORT_ID_EPL],
						[newRiskMultiplierForNba, newRiskMultiplierForEpl]
					)
			).to.be.revertedWith('Only the contract owner may perform this action');
			await expect(
				sportsAMMV2RiskManager.setRiskMultipliers(
					[INVALID_SPORT_ID, SPORT_ID_EPL],
					[newRiskMultiplierForNba, newRiskMultiplierForEpl]
				)
			).to.be.revertedWith('Invalid ID for sport');
			await expect(
				sportsAMMV2RiskManager.setRiskMultipliers(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[invalidRiskMultiplier, newRiskMultiplierForEpl]
				)
			).to.be.revertedWith('Invalid multiplier');

			await sportsAMMV2RiskManager.setRiskMultipliers(
				[SPORT_ID_NBA, SPORT_ID_EPL],
				[newRiskMultiplierForNba, newRiskMultiplierForEpl]
			);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_NBA)).to.equal(
				newRiskMultiplierForNba
			);
			expect(await sportsAMMV2RiskManager.riskMultiplierPerSport(SPORT_ID_EPL)).to.equal(
				newRiskMultiplierForEpl
			);

			await expect(
				sportsAMMV2RiskManager.setRiskMultipliers(
					[SPORT_ID_NBA, SPORT_ID_EPL],
					[newRiskMultiplierForNba, newRiskMultiplierForEpl]
				)
			)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_NBA, newRiskMultiplierForNba)
				.to.emit(sportsAMMV2RiskManager, 'SetRiskMultiplierPerSport')
				.withArgs(SPORT_ID_EPL, newRiskMultiplierForEpl);
		});
	});
});
