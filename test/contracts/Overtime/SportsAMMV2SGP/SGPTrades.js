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

		await sportsAMMV2LiquidityPoolETH
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1'));
		await sportsAMMV2LiquidityPoolETH.start();

		quote = await sportsAMMV2.tradeQuote(
			tradeDataThreeMarketsCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);
		quoteETH = await sportsAMMV2.tradeQuote(
			tradeDataThreeMarketsCurrentRound,
			ETH_BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);
	});

	describe('SGP Trade', () => {
		it('Should buy a SGP trade', async () => {
			expect(quote.payout).to.equal(ethers.parseEther('42.735042735042735042'));

			await sgpTradingProcessor.connect(firstTrader).requestSGPTrade({
				_tradeData: tradeDataThreeMarketsCurrentRound,
				_buyInAmount: BUY_IN_AMOUNT,
				_expectedQuote: quote.totalQuote,
				_additionalSlippage: ADDITIONAL_SLIPPAGE,
				_referrer: ZERO_ADDRESS,
				_collateral: ZERO_ADDRESS,
			});

			let requestId = await sgpTradingProcessor.counterToRequestId(0);
			console.log('requestId is ' + requestId);

			await mockChainlinkOracle.fulfillSGPTrade(requestId, true, quote.totalQuote);

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
