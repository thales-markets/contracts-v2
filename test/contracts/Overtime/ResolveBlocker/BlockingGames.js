const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_NBA,
	RESULT_TYPE,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('ResolveBlocker Blocking games', () => {
	let sportsAMMV2,
		sportsAMMV2Data,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		resolveBlocker,
		owner,
		secondAccount,
		thirdAccount,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		freeBetsHolder,
		collateralAddress,
		sportsAMMV2RiskManager,
		mockChainlinkOracle,
		liveTradingProcessor,
		sportsAMMV2ResultManager;
	const secondGame = '0x3361313961063935343164563637633634613865623623039435363366336666';
	const thirdGame = '0x6106393361313935343336346138336633665623623031645636376943536666';
	const blockReason = 'Spent on markets exceed market cap';

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			resolveBlocker,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			freeBetsHolder,
			collateralAddress,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			liveTradingProcessor,
			sportsAMMV2ResultManager,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ firstLiquidityProvider, firstTrader, owner, secondAccount, thirdAccount } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	describe('Game blocking', () => {
		it('should block games when called by a whitelisted address and emit event', async () => {
			const gameIds = [tradeDataCurrentRound[0].gameId, secondGame];

			await expect(resolveBlocker.connect(owner).blockGames(gameIds, blockReason))
				.to.emit(resolveBlocker, 'GamesBlockedForResolution')
				.withArgs(gameIds, blockReason);

			expect(await resolveBlocker.gameIdBlockedForResolution(tradeDataCurrentRound[0].gameId)).to.be
				.true;
			expect(await resolveBlocker.gameIdBlockedForResolution(secondGame)).to.be.true;
		});

		it('should unblock games when called by a whitelisted address and emit event', async () => {
			const gameIds = [tradeDataCurrentRound[0].gameId];

			await resolveBlocker.connect(owner).blockGames(gameIds, blockReason);

			await expect(resolveBlocker.connect(owner).unblockGames(gameIds))
				.to.emit(resolveBlocker, 'GamesUnblockedForResolution')
				.withArgs(gameIds);

			expect(await resolveBlocker.gameIdBlockedForResolution(tradeDataCurrentRound[0].gameId)).to.be
				.false;
			expect(await resolveBlocker.gameIdUnblockedByAdmin(tradeDataCurrentRound[0].gameId)).to.be
				.true;
		});

		it('should revert blocking games when called by a non-whitelisted address', async () => {
			await expect(
				resolveBlocker
					.connect(thirdAccount)
					.blockGames([tradeDataCurrentRound[0].gameId], blockReason)
			).to.be.revertedWith('Invalid sender');
		});

		it('should revert unblocking games when called by a non-whitelisted address', async () => {
			await resolveBlocker
				.connect(owner)
				.blockGames([tradeDataCurrentRound[0].gameId], blockReason);
			await expect(
				resolveBlocker.connect(thirdAccount).unblockGames([tradeDataCurrentRound[0].gameId])
			).to.be.revertedWith('Invalid sender');
		});

		it('should return correct blocking status with getGamesBlockedForResolution', async () => {
			await resolveBlocker
				.connect(owner)
				.blockGames([tradeDataCurrentRound[0].gameId, secondGame], blockReason);
			const [blockedGames, unblockGames] = await resolveBlocker.getGamesBlockedForResolution([
				tradeDataCurrentRound[0].gameId,
				secondGame,
				thirdGame,
			]);
			expect(blockedGames).to.deep.equal([true, true, false]);
			expect(unblockGames).to.deep.equal([false, false, false]);
		});

		it('should return correct blocking and unblocked status after blocking and unblocking', async () => {
			const gameIds = [tradeDataCurrentRound[0].gameId, secondGame];

			await resolveBlocker.connect(owner).blockGames(gameIds, blockReason);
			let [blockedGames, unblockedGames] = await resolveBlocker.getGamesBlockedForResolution([
				tradeDataCurrentRound[0].gameId,
				secondGame,
				thirdGame,
			]);
			expect(blockedGames).to.deep.equal([true, true, false]);
			expect(unblockedGames).to.deep.equal([false, false, false]);

			await resolveBlocker.connect(owner).unblockGames(gameIds);
			[blockedGames, unblockedGames] = await resolveBlocker.getGamesBlockedForResolution([
				tradeDataCurrentRound[0].gameId,
				secondGame,
				thirdGame,
			]);
			expect(blockedGames).to.deep.equal([false, false, false]);
			expect(unblockedGames).to.deep.equal([true, true, false]);
		});

		it('should emit correct events when blocking multiple games', async () => {
			const gameIds = [tradeDataCurrentRound[0].gameId, secondGame, thirdGame];

			await expect(resolveBlocker.connect(owner).blockGames(gameIds, blockReason))
				.to.emit(resolveBlocker, 'GamesBlockedForResolution')
				.withArgs(gameIds, blockReason);
		});

		it('should emit correct events when unblocking multiple games', async () => {
			const gameIds = [tradeDataCurrentRound[0].gameId, secondGame, thirdGame];

			await resolveBlocker.connect(owner).blockGames(gameIds, blockReason);

			await expect(resolveBlocker.connect(owner).unblockGames(gameIds))
				.to.emit(resolveBlocker, 'GamesUnblockedForResolution')
				.withArgs(gameIds);
		});
	});

	describe('Set Manager and SportsAMMData', () => {
		it('should allow the owner to set a new manager', async () => {
			const newManager = secondAccount.address;
			await resolveBlocker.setManager(newManager);
			expect(await resolveBlocker.manager()).to.equal(newManager);
		});

		it('should revert when setting manager to zero address', async () => {
			await expect(resolveBlocker.setManager(ZERO_ADDRESS)).to.be.revertedWith('Invalid address');
		});

		it('should revert when a non-owner tries to set the manager', async () => {
			await expect(
				resolveBlocker.connect(thirdAccount).setManager(secondAccount.address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('should allow the owner to set a new sportsAMMData', async () => {
			const newSportsAMMData = secondAccount.address;
			await resolveBlocker.setSportsAMMData(newSportsAMMData);
			expect(await resolveBlocker.sportsAMMData()).to.equal(newSportsAMMData);
		});

		it('should revert when setting sportsAMMData to zero address', async () => {
			await expect(resolveBlocker.setSportsAMMData(ZERO_ADDRESS)).to.be.revertedWith(
				'Invalid address'
			);
		});

		it('should revert when a non-owner tries to set sportsAMMData', async () => {
			await expect(
				resolveBlocker.connect(thirdAccount).setSportsAMMData(secondAccount.address)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});
	});
});
