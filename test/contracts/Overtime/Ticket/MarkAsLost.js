const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const {
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	RESULT_TYPE,
	GAME_ID_1,
} = require('../../../constants/overtime');
const { ZERO_ADDRESS } = require('../../../constants/general');

describe('Admin MarkAsLost Functionality', () => {
	let sportsAMMV2,
		sportsAMMV2Manager,
		sportsAMMV2ResultManager,
		sportsAMMV2LiquidityPool,
		collateral,
		firstLiquidityProvider,
		firstTrader,
		secondAccount,
		tradeDataCurrentRound;

	beforeEach(async () => {
		({
			sportsAMMV2,
			sportsAMMV2Manager,
			sportsAMMV2ResultManager,
			sportsAMMV2LiquidityPool,
			collateral,
			tradeDataCurrentRound,
		} = await loadFixture(deploySportsAMMV2Fixture));

		({ firstLiquidityProvider, firstTrader, secondAccount } =
			await loadFixture(deployAccountsFixture));

		await sportsAMMV2LiquidityPool
			.connect(firstLiquidityProvider)
			.deposit(ethers.parseEther('1000'));
		await sportsAMMV2LiquidityPool.start();
	});

	it('admin can mark ticket as lost and funds go to AMM', async () => {
		// Setup trade and result type
		tradeDataCurrentRound[0].position = 0;
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

		// Execute trade
		const quote = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		const TicketContract = await ethers.getContractFactory('Ticket');
		const userTicket = await TicketContract.attach(ticketAddress);

		const ticketCollateral = await userTicket.collateral();
		const preBalance = await collateral.balanceOf(ticketAddress);

		// Whitelist admin
		await sportsAMMV2Manager.setWhitelistedAddresses([secondAccount], 2, true);

		// Admin marks ticket as lost
		await expect(sportsAMMV2.connect(secondAccount).markAsLost(ticketAddress))
			.to.emit(userTicket, 'Resolved')
			.withArgs(false, false);

		// Ticket should be marked as lost and resolved
		expect(await userTicket.isMarkedAsLost()).to.be.equal(true);
		expect(await userTicket.resolved()).to.be.equal(true);
		expect(await userTicket.cancelled()).to.be.equal(false);

		// Funds should be drained from ticket contract
		const postBalance = await collateral.balanceOf(ticketAddress);
		expect(postBalance).to.be.equal(0);
		expect(preBalance).to.be.gt(0);

		// Ticket should be removed from active list
		expect(await sportsAMMV2Manager.isActiveTicket(ticketAddress)).to.be.equal(false);
	});

	it('non-whitelisted address cannot mark ticket as lost', async () => {
		tradeDataCurrentRound[0].position = 0;
		await sportsAMMV2ResultManager.setResultTypesPerMarketTypes([0], [RESULT_TYPE.ExactPosition]);

		const quote = await sportsAMMV2.tradeQuote(
			tradeDataCurrentRound,
			BUY_IN_AMOUNT,
			ZERO_ADDRESS,
			false
		);

		await sportsAMMV2
			.connect(firstTrader)
			.trade(
				tradeDataCurrentRound,
				BUY_IN_AMOUNT,
				quote.totalQuote,
				ADDITIONAL_SLIPPAGE,
				ZERO_ADDRESS,
				ZERO_ADDRESS,
				false
			);

		const activeTickets = await sportsAMMV2Manager.getActiveTickets(0, 100);
		const ticketAddress = activeTickets[0];

		// Expect revert from unauthorized account
		await expect(sportsAMMV2.connect(firstTrader).markAsLost(ticketAddress)).to.be.revertedWith(
			'UnsupportedSender'
		);
	});
});
