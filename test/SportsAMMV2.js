const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { getTicketTradeData } = require('./utils/overtime');
const { BUY_IN_AMOUNT } = require('./constants/overtime');

describe('SportsAMMV2', () => {
	let sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		sportsAMMV2,
		ticketMastercopy,
		sportsAMMV2LiquidityPool,
		collateral,
		referrals,
		stakingThales,
		safeBox,
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		fifthAccount,
		tradeData;

	beforeEach(async () => {
		const sportsAMMV2Fixture = await loadFixture(deploySportsAMMV2Fixture);
		const accountsFixture = await loadFixture(deployAccountsFixture);

		sportsAMMV2Manager = sportsAMMV2Fixture.sportsAMMV2Manager;
		sportsAMMV2RiskManager = sportsAMMV2Fixture.sportsAMMV2RiskManager;
		sportsAMMV2 = sportsAMMV2Fixture.sportsAMMV2;
		ticketMastercopy = sportsAMMV2Fixture.ticketMastercopy;
		sportsAMMV2LiquidityPool = sportsAMMV2Fixture.sportsAMMV2LiquidityPool;
		collateral = sportsAMMV2Fixture.collateral;
		referrals = sportsAMMV2Fixture.referrals;
		stakingThales = sportsAMMV2Fixture.stakingThales;
		safeBox = sportsAMMV2Fixture.safeBox;
		owner = sportsAMMV2Fixture.owner;
		secondAccount = accountsFixture.secondAccount;
		thirdAccount = accountsFixture.thirdAccount;
		fourthAccount = accountsFixture.fourthAccount;
		fifthAccount = accountsFixture.fourthAccount;

		tradeData = getTicketTradeData();
	});

	describe('Quote', () => {
		it('Should get quote', async () => {
			const quote = await sportsAMMV2.tradeQuote(tradeData, BUY_IN_AMOUNT);

			expect(quote.payout).to.equal(ethers.parseEther('14.848484848484848484'));
		});
	});
});
