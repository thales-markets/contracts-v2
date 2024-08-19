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
const MAX_APPROVAL =
	'115792089237316195423570985008687907853269984665640564039457584007913129639935';

describe('StakingThalesBettingProxy', () => {
	let sportsAMMV2,
		sportsAMMV2Data,
		sportsAMMV2Manager,
		sportsAMMV2LiquidityPool,
		sportsAMMV2THALESLiquidityPool,
		tradeDataCurrentRound,
		tradeDataTenMarketsCurrentRound,
		owner,
		firstLiquidityProvider,
		firstTrader,
		stakingThalesBettingProxy,
		collateralTHALESAddress,
		collateralTHALES,
		collateral18,
		sportsAMMV2RiskManager,
		mockChainlinkOracle,
		liveTradingProcessor,
		sportsAMMV2ResultManager,
		stakingThales;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Data,
			sportsAMMV2Manager,
			sportsAMMV2LiquidityPool,
			sportsAMMV2THALESLiquidityPool,
			tradeDataCurrentRound,
			tradeDataTenMarketsCurrentRound,
			stakingThalesBettingProxy,
			collateralTHALESAddress,
			collateralTHALES,
			collateral18,
			sportsAMMV2RiskManager,
			mockChainlinkOracle,
			liveTradingProcessor,
			sportsAMMV2ResultManager,
			stakingThales,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ owner, firstLiquidityProvider, firstTrader } = await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await sportsAMMV2THALESLiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2THALESLiquidityPool.start();
	});

	describe('Trade with staked tokens', () => {
		it('Should fail with insufficient staked amount', async () => {
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('5')); // Stake less than required

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			expect(Number(quote.payout.toString() / 1e18).toFixed(5)).to.equal(
				Number(Number(BUY_IN_AMOUNT.toString()) / Number(quote.totalQuote.toString())).toFixed(5)
			);

			await expect(
				stakingThalesBettingProxy
					.connect(firstTrader)
					.trade(
						tradeDataCurrentRound,
						BUY_IN_AMOUNT,
						quote.totalQuote,
						ADDITIONAL_SLIPPAGE,
						collateralTHALESAddress
					)
			).to.be.revertedWith('Insufficient staked balance');
		});

		it('Should pass', async () => {
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			expect(Number(quote.payout.toString() / 1e18).toFixed(5)).to.equal(
				Number(Number(BUY_IN_AMOUNT.toString()) / Number(quote.totalQuote.toString())).toFixed(5)
			);

			await stakingThalesBettingProxy
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					collateralTHALESAddress
				);

			const activeTickets = await stakingThalesBettingProxy.getActiveTicketsPerUser(
				0,
				1,
				firstTrader
			);
			expect(activeTickets.length).to.equal(1);
		});

		it('Should pass live', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			await stakingThalesBettingProxy.connect(firstTrader).tradeLive({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: collateralTHALESAddress,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);
		});

		it('Should claim winnings', async () => {
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked
			const stakingBalanceInit = await stakingThales.stakedBalanceOf(firstTrader);

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			await stakingThalesBettingProxy
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					collateralTHALESAddress
				);

			await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

			await sportsAMMV2ResultManager.setResultsPerMarkets(
				[tradeDataCurrentRound[0].gameId],
				[tradeDataCurrentRound[0].typeId],
				[tradeDataCurrentRound[0].playerId],
				[[tradeDataCurrentRound[0].position]]
			);
			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];
			const ticketsDataBeforeExercise = await sportsAMMV2Data.getTicketsData([ticketAddress]);

			const stakingBalanceBefore = await stakingThales.stakedBalanceOf(firstTrader.address);
			await sportsAMMV2.connect(firstTrader).exerciseTicket(ticketAddress);
			const ticketsData = await sportsAMMV2Data.getTicketsData([ticketAddress]);

			const firstTraderStakedBalance = await stakingThales.stakedBalanceOf(firstTrader.address);
			expect(parseInt(parseInt(firstTraderStakedBalance) / 1e6)).to.be.equal(
				parseInt((parseInt(stakingBalanceBefore) + parseInt(ticketsData[0][17])) / 1e6)
			); // Ensure it increased after winning
		});

		it('User tickets history getters', async () => {
			await stakingThales.connect(firstTrader).stake(ethers.parseEther('100')); // Ensure enough staked

			const quote = await sportsAMMV2.tradeQuote(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				collateralTHALESAddress,
				false
			);

			await stakingThalesBettingProxy
				.connect(firstTrader)
				.trade(
					tradeDataCurrentRound,
					BUY_IN_AMOUNT,
					quote.totalQuote,
					ADDITIONAL_SLIPPAGE,
					collateralTHALESAddress
				);

			let numActive = await stakingThalesBettingProxy.numOfActiveTicketsPerUser(firstTrader);
			expect(numActive).to.equal(1);

			await stakingThalesBettingProxy.getActiveTicketsPerUser(0, 1, firstTrader);

			let numResolved = await stakingThalesBettingProxy.numOfResolvedTicketsPerUser(firstTrader);
			expect(numResolved).to.equal(0);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const [, , activeStakingBettingProxy] = await sportsAMMV2Data.getActiveTicketsDataPerUser(
				firstTrader,
				0,
				100
			);

			await stakingThalesBettingProxy.getResolvedTicketsPerUser(0, 1, firstTrader);

			expect(activeStakingBettingProxy.length).to.be.equal(1);
			expect(activeStakingBettingProxy[0].id).to.be.equal(ticketAddress);

			const [, , resolvedStakingBettingProxy] = await sportsAMMV2Data.getResolvedTicketsDataPerUser(
				firstTrader,
				0,
				100
			);
			expect(resolvedStakingBettingProxy.length).to.be.equal(0);
		});
		it('Retrieve funds', async () => {
			const initialBalance = await collateralTHALES.balanceOf(owner.address);

			await collateralTHALES
				.connect(firstTrader)
				.transfer(stakingThalesBettingProxy.target, ethers.parseEther('100'));
			await stakingThalesBettingProxy.retrieveFunds(
				collateralTHALESAddress,
				ethers.parseEther('100')
			);

			const afterBalance = await collateralTHALES.balanceOf(owner.address);
			expect(afterBalance).to.be.equal(initialBalance + ethers.parseEther('100'));
		});
	});
	describe('Setter functions', () => {
		it('Should set new StakingThales address and emit event', async () => {
			const newStakingThales = ethers.Wallet.createRandom().address;

			await expect(stakingThalesBettingProxy.connect(owner).setStakingThales(newStakingThales))
				.to.emit(stakingThalesBettingProxy, 'SetStakingThales')
				.withArgs(newStakingThales);

			expect(await stakingThalesBettingProxy.stakingThales()).to.equal(newStakingThales);

			const approvedAmount = await collateralTHALES.allowance(
				stakingThalesBettingProxy.target,
				newStakingThales
			);
			expect(approvedAmount).to.equal(MAX_APPROVAL);
		});

		it('Should set new SportsAMM address and emit event', async () => {
			const newSportsAMM = ethers.Wallet.createRandom().address;

			await expect(stakingThalesBettingProxy.connect(owner).setSportsAMM(newSportsAMM))
				.to.emit(stakingThalesBettingProxy, 'SetSportsAMM')
				.withArgs(newSportsAMM);

			expect(await stakingThalesBettingProxy.sportsAMM()).to.equal(newSportsAMM);

			const approvedAmount = await collateralTHALES.allowance(
				stakingThalesBettingProxy.target,
				newSportsAMM
			);
			expect(approvedAmount).to.equal(MAX_APPROVAL);
		});

		it('Should set new LiveTradingProcessor address and emit event', async () => {
			const newLiveTradingProcessor = ethers.Wallet.createRandom().address;

			await expect(
				stakingThalesBettingProxy.connect(owner).setLiveTradingProcessor(newLiveTradingProcessor)
			)
				.to.emit(stakingThalesBettingProxy, 'SetLiveTradingProcessor')
				.withArgs(newLiveTradingProcessor);

			expect(await stakingThalesBettingProxy.liveTradingProcessor()).to.equal(
				newLiveTradingProcessor
			);

			const approvedAmount = await collateralTHALES.allowance(
				stakingThalesBettingProxy.target,
				newLiveTradingProcessor
			);
			expect(approvedAmount).to.equal(MAX_APPROVAL);
		});

		it('Should set new StakingCollateral address and emit event', async () => {
			const newStakingCollateral = collateral18.target;

			await expect(
				stakingThalesBettingProxy.connect(owner).setStakingCollateral(newStakingCollateral)
			)
				.to.emit(stakingThalesBettingProxy, 'SetStakingCollateral')
				.withArgs(newStakingCollateral);

			expect(await stakingThalesBettingProxy.stakingCollateral()).to.equal(newStakingCollateral);

			const approvedForStakingThales = await collateralTHALES.allowance(
				stakingThalesBettingProxy.target,
				await stakingThalesBettingProxy.stakingThales()
			);
			const approvedForSportsAMM = await collateralTHALES.allowance(
				stakingThalesBettingProxy.target,
				await stakingThalesBettingProxy.sportsAMM()
			);
			const approvedForLiveTradingProcessor = await collateralTHALES.allowance(
				stakingThalesBettingProxy.target,
				await stakingThalesBettingProxy.liveTradingProcessor()
			);

			const approvedForStakingThalesNewCollateral = await collateral18.allowance(
				stakingThalesBettingProxy.target,
				await stakingThalesBettingProxy.stakingThales()
			);
			const approvedForSportsAMMNewCollateral = await collateral18.allowance(
				stakingThalesBettingProxy.target,
				await stakingThalesBettingProxy.sportsAMM()
			);
			const approvedForLiveTradingProcessorNewCollateral = await collateral18.allowance(
				stakingThalesBettingProxy.target,
				await stakingThalesBettingProxy.liveTradingProcessor()
			);

			expect(approvedForStakingThales).to.equal(0);
			expect(approvedForSportsAMM).to.equal(0);
			expect(approvedForLiveTradingProcessor).to.equal(0);
			expect(approvedForStakingThalesNewCollateral).to.equal(MAX_APPROVAL);
			expect(approvedForSportsAMMNewCollateral).to.equal(MAX_APPROVAL);
			expect(approvedForLiveTradingProcessorNewCollateral).to.equal(MAX_APPROVAL);
		});
	});
});
