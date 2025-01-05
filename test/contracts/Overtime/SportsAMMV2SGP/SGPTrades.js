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
		tradeDataThreeMarketsCurrentRound,
		sameGameWithFirstPlayerProps,
		firstLiquidityProvider,
		firstTrader,
		secondAccount,
		sgpTradingProcessor,
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
			tradeDataThreeMarketsCurrentRound,
			sameGameWithFirstPlayerProps,
			sgpTradingProcessor,
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
	});

	describe('SGP Trade', () => {
		it('Should buy a SGP trade', async () => {
			let approvedQuote = ethers.parseEther('0.5');

			await sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
				_tradeData: tradeDataThreeMarketsCurrentRound,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: approvedQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillSGPTrade(requestId, true, approvedQuote);

			const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
			const ticketAddress = activeTickets[0];

			const TicketContract = await ethers.getContractFactory('Ticket');
			const userTicket = await TicketContract.attach(ticketAddress);

			const marketData = await userTicket.markets(0);

			// expect(marketData.odd).to.equal(ethers.parseEther('0.5'));
			//
			// expect(await userTicket.isLive()).to.eq(true);
		});
	});
});
