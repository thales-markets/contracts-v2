const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ETH_BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	SPORT_ID_NBA,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');
const { ethers } = require('hardhat');

describe('SportsAMMV2Live Live Trades', () => {
	let sportsAMMV2,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolETH,
		tradeDataCurrentRound,
		firstLiquidityProvider,
		firstTrader,
		secondAccount,
		liveTradingProcessor,
		liveTradingProcessorData,
		mockChainlinkOracle,
		sportsAMMV2RiskManager,
		weth,
		quote,
		sportsAMMV2Manager;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2LiquidityPool,
			sportsAMMV2LiquidityPoolETH,
			tradeDataCurrentRound,
			liveTradingProcessor,
			liveTradingProcessorData,
			mockChainlinkOracle,
			weth,
			sportsAMMV2RiskManager,
			sportsAMMV2Manager,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ owner, firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();

		await sportsAMMV2LiquidityPoolETH
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1'));
		await sportsAMMV2LiquidityPoolETH.start();

		quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, ZERO_ADDRESS, false);
		quoteETH = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			ETH_BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);
	});

	describe('Live Trade', () => {
		it('Should buy a live trade', async () => {
			expect(quote.payout).to.equal(ethers.parseEther('20'));

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			const marketData = await userTicket.markets(0);

			expect(marketData.odd).to.equal(ethers.parseEther('0.5'));

			expect(await userTicket.isLive()).to.eq(true);
		});

		it('Should buy a live trade with referrer', async () => {
			expect(quote.payout).to.equal(ethers.parseEther('20'));

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: secondAccount,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);
		});

		it('Should buy a live trade with WETH collateral', async () => {
			console.log('quoteETH.payout : ', quoteETH.payout.toString());
			expect(quoteETH.payout).to.equal(ethers.parseEther('0.0057142857142858'));

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: ETH_BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: weth,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quoteETH.totalQuote);
		});

		it('Fail for unsupported sports', async () => {
			await expect(
				liveTradingProcessor.connect(firstTrader).requestLiveTrade({
					_gameId: tradeDataCurrentRound[0].gameId,
					_sportId: tradeDataCurrentRound[0].sportId,
					_typeId: tradeDataCurrentRound[0].typeId,
					_line: tradeDataCurrentRound[0].line,
					_position: tradeDataCurrentRound[0].position,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: quote.totalQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				})
			).to.be.revertedWith('Live trading not enabled on _sportId');
		});

		it('Fail for double fulfillment', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote);

			await expect(
				mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote)
			).to.be.revertedWith('Source must be the oracle of the request');
		});

		it('Fail with delay on execution', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			// delay the response more than allowed
			await time.increase(61);

			await expect(
				mockChainlinkOracle.fulfillLiveTrade(requestId, true, quote.totalQuote)
			).to.be.revertedWith('Request timed out');
		});

		it('Fail on slippage', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await expect(
				mockChainlinkOracle.fulfillLiveTrade(
					requestId,
					true,
					ethers.parseEther((ethers.formatEther(quote.totalQuote) * 2).toString())
				)
			).to.be.revertedWith('Slippage too high');
		});

		it('Should fail with "Only the contract owner may perform this action"', async () => {
			await expect(
				sportsAMMV2RiskManager
					.connect(secondAccount)
					.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true)
			).to.be.revertedWith('Only the contract owner may perform this action');
		});

		it('Send empty gameid', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: '',
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await liveTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);
		});

		it('Default Cap checker', async () => {
			const capRegular = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				tradeDataCurrentRound[0].gameId,
				SPORT_ID_NBA,
				0,
				0,
				0,
				tradeDataCurrentRound[0].maturity,
				false
			);

			const capLive = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				tradeDataCurrentRound[0].gameId,
				SPORT_ID_NBA,
				0,
				0,
				0,
				tradeDataCurrentRound[0].maturity,
				true
			);

			expect(capRegular / capLive).to.equal(2);
		});

		it('Dedicated live cap checker', async () => {
			await sportsAMMV2RiskManager.setLiveCapDivider(SPORT_ID_NBA, 10);
			const capRegular = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				tradeDataCurrentRound[0].gameId,
				SPORT_ID_NBA,
				0,
				0,
				0,
				tradeDataCurrentRound[0].maturity,
				false
			);

			const capLive = await sportsAMMV2RiskManager.calculateCapToBeUsed(
				tradeDataCurrentRound[0].gameId,
				SPORT_ID_NBA,
				0,
				0,
				0,
				tradeDataCurrentRound[0].maturity,
				true
			);

			expect(capRegular / capLive).to.equal(10);
		});
		it('Should withdraw collateral successfully by the owner', async () => {
			// Transfer some tokens to the contract (mocking collateral)
			const amountToDeposit = ethers.parseEther('0.1');
			const amountBefore = await weth.balanceOf(firstTrader.address);
			await weth.connect(firstTrader).transfer(liveTradingProcessor.target, amountToDeposit);

			// Verify the contract balance
			expect(await weth.balanceOf(liveTradingProcessor.target)).to.equal(amountToDeposit);

			// Withdraw the collateral as the owner
			await liveTradingProcessor
				.connect(owner)
				.withdrawCollateral(weth.target, firstTrader.address);

			// Verify the recipient received the tokens
			expect(await weth.balanceOf(firstTrader.address)).to.equal(amountBefore);

			// Verify the contract balance is now zero
			expect(await weth.balanceOf(liveTradingProcessor.target)).to.equal(0);
		});

		it('Should fail to withdraw collateral if not the owner', async () => {
			// Attempt to withdraw collateral as a non-owner
			await expect(
				liveTradingProcessor
					.connect(secondAccount)
					.withdrawCollateral(weth.target, secondAccount.address)
			).to.be.reverted;
		});

		it('Should return trade data', async () => {
			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
				_gameId: tradeDataCurrentRound[0].gameId,
				_sportId: tradeDataCurrentRound[0].sportId,
				_typeId: tradeDataCurrentRound[0].typeId,
				_line: tradeDataCurrentRound[0].line,
				_position: tradeDataCurrentRound[0].position,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			const requestId = await liveTradingProcessor.counterToRequestId(0);

			const tradeData = await liveTradingProcessor.getTradeData(requestId);

			expect(tradeData._gameId).to.eq(tradeDataCurrentRound[0].gameId);
			expect(tradeData._buyInAmount).to.eq(BUY_IN_AMOUNT);
		});
	});

	describe('Live Trade Data', () => {
		it('Should get a live trade requests', async () => {
			// GIVEN 5 live requests
			const NUM_OF_REQUESTS = 5;

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			for (let i = 0; i < NUM_OF_REQUESTS; i++) {
				await liveTradingProcessor.connect(firstTrader).requestLiveTrade({
					_gameId: tradeDataCurrentRound[0].gameId,
					_sportId: tradeDataCurrentRound[0].sportId,
					_typeId: tradeDataCurrentRound[0].typeId,
					_line: tradeDataCurrentRound[0].line,
					_position: tradeDataCurrentRound[0].position,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: quote.totalQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				});
			}

			const userFirstRequestId = await liveTradingProcessor.counterToRequestId(0);

			await mockChainlinkOracle.fulfillLiveTrade(userFirstRequestId, true, quote.totalQuote);

			// WHEN trying to fetch requests data for page size
			const PAGE_SIZE = 3;
			const requestsData = await liveTradingProcessorData.getRequestsData(0, PAGE_SIZE);

			// THEN exactly PAGE_SIZE is retrieved, user and request ID is matching
			expect(requestsData.length).to.eq(PAGE_SIZE);
			expect(requestsData[0].user).to.eq(firstTrader.address);
			expect(requestsData[0].requestId).to.eq(userFirstRequestId);
			expect(requestsData[0].ticketId).to.not.eq(userFirstRequestId);
		});

		it('Should get a live trade requests data by user', async () => {
			// GIVEN 5 live requests where latest request is from different user
			const NUM_OF_REQUESTS = 5;
			let userLastRequestIndex;

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			for (let i = 0; i < NUM_OF_REQUESTS; i++) {
				const user = i == NUM_OF_REQUESTS - 1 ? secondAccount : firstTrader;
				userLastRequestIndex = user == firstTrader ? i : userLastRequestIndex;

				await liveTradingProcessor.connect(user).requestLiveTrade({
					_gameId: tradeDataCurrentRound[0].gameId,
					_sportId: tradeDataCurrentRound[0].sportId,
					_typeId: tradeDataCurrentRound[0].typeId,
					_line: tradeDataCurrentRound[0].line,
					_position: tradeDataCurrentRound[0].position,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: quote.totalQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				});
			}

			const userLastRequestId = await liveTradingProcessor.counterToRequestId(userLastRequestIndex);

			await mockChainlinkOracle.fulfillLiveTrade(userLastRequestId, true, quote.totalQuote);

			// WHEN trying to fetch last request data for user
			const BATCH_SIZE = 10;
			const MAX_DATA_SIZE = 1;
			const requestsData = await liveTradingProcessorData.getLatestRequestsDataPerUser(
				firstTrader,
				BATCH_SIZE,
				MAX_DATA_SIZE
			);

			// THEN exactly MAX_DATA_SIZE is retrieved, user and request ID is matching last request is fulfilled
			expect(requestsData.length).to.eq(MAX_DATA_SIZE);
			expect(requestsData[0].user).to.eq(firstTrader.address);
			expect(requestsData[0].requestId).to.eq(userLastRequestId);
			expect(requestsData[0].isFulfilled).to.eq(true);
		});

		it('Should get a live trade requests data by user for smaller batch size', async () => {
			// GIVEN 5 live requests where latest request is from different user
			const NUM_OF_REQUESTS = 5;
			let userLastRequestIndex;

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			for (let i = 0; i < NUM_OF_REQUESTS; i++) {
				const user = i == NUM_OF_REQUESTS - 1 ? secondAccount : firstTrader;
				userLastRequestIndex = user == firstTrader ? i : userLastRequestIndex;

				await liveTradingProcessor.connect(user).requestLiveTrade({
					_gameId: tradeDataCurrentRound[0].gameId,
					_sportId: tradeDataCurrentRound[0].sportId,
					_typeId: tradeDataCurrentRound[0].typeId,
					_line: tradeDataCurrentRound[0].line,
					_position: tradeDataCurrentRound[0].position,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: quote.totalQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				});
			}

			const userLastRequestId = await liveTradingProcessor.counterToRequestId(userLastRequestIndex);

			await mockChainlinkOracle.fulfillLiveTrade(userLastRequestId, true, quote.totalQuote);

			// WHEN batch size is less than total number of requsts
			const BATCH_SIZE = 2;
			const MAX_DATA_SIZE = 2;
			const requestsData = await liveTradingProcessorData.getLatestRequestsDataPerUser(
				firstTrader,
				BATCH_SIZE,
				MAX_DATA_SIZE
			);

			// THEN non empty data length is less than MAX_DATA_SIZE, user and request ID is matching,
			// last request is fulfilled and previous request is not fulfilled
			expect(requestsData.filter((data) => Number(data.timestamp) !== 0).length).to.lt(
				MAX_DATA_SIZE
			);
			expect(requestsData[0].user).to.eq(firstTrader.address);
			expect(requestsData[0].requestId).to.eq(userLastRequestId);
			expect(requestsData[0].isFulfilled).to.eq(true);
			expect(requestsData[1].isFulfilled).to.eq(false);
		});

		it('Should get a live trade requests data by user for greater max size', async () => {
			// GIVEN 5 live requests where latest request is from different user
			const NUM_OF_REQUESTS = 5;
			let userLastRequestIndex;

			await sportsAMMV2RiskManager.setLiveTradingPerSportAndTypeEnabled(SPORT_ID_NBA, 0, true);

			for (let i = 0; i < NUM_OF_REQUESTS; i++) {
				const user = i == NUM_OF_REQUESTS - 1 ? secondAccount : firstTrader;
				userLastRequestIndex = user == firstTrader ? i : userLastRequestIndex;

				await liveTradingProcessor.connect(user).requestLiveTrade({
					_gameId: tradeDataCurrentRound[0].gameId,
					_sportId: tradeDataCurrentRound[0].sportId,
					_typeId: tradeDataCurrentRound[0].typeId,
					_line: tradeDataCurrentRound[0].line,
					_position: tradeDataCurrentRound[0].position,
					_buyInAmount: BUY_IN_AMOUNT,
					_expectedQuote: quote.totalQuote,
					_additionalSlippage: ADDITIONAL_SLIPPAGE,
					_referrer: ZERO_ADDRESS,
					_collateral: ZERO_ADDRESS,
				});
			}

			const userLastRequestId = await liveTradingProcessor.counterToRequestId(userLastRequestIndex);

			await mockChainlinkOracle.fulfillLiveTrade(userLastRequestId, true, quote.totalQuote);

			// WHEN MAX_DATA_SIZE is greater than user requests
			const BATCH_SIZE = 10;
			const MAX_DATA_SIZE = NUM_OF_REQUESTS;
			const requestsData = await liveTradingProcessorData.getLatestRequestsDataPerUser(
				firstTrader,
				BATCH_SIZE,
				MAX_DATA_SIZE
			);

			// THEN non empty data length is less than MAX_DATA_SIZE, user and request ID is matching and last request is fulfilled
			expect(requestsData.filter((data) => Number(data.timestamp) !== 0).length).to.lt(
				MAX_DATA_SIZE
			);
			expect(requestsData[0].user).to.eq(firstTrader.address);
			expect(requestsData[0].requestId).to.eq(userLastRequestId);
			expect(requestsData[0].isFulfilled).to.eq(true);
		});
	});
});
