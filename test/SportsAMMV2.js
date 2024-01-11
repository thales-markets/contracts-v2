const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('./utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_INITAL_PARAMS } = require('./constants/overtimeContractParams');
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

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2.owner()).to.equal(owner.address);
		});

		it('Should set the right addresses', async () => {
			expect(await sportsAMMV2.defaultCollateral()).to.equal(await collateral.getAddress());
			expect(await sportsAMMV2.manager()).to.equal(await sportsAMMV2Manager.getAddress());
			expect(await sportsAMMV2.riskManager()).to.equal(await sportsAMMV2RiskManager.getAddress());
			expect(await sportsAMMV2.referrals()).to.equal(referrals.address);
			expect(await sportsAMMV2.stakingThales()).to.equal(stakingThales.address);
			expect(await sportsAMMV2.safeBox()).to.equal(safeBox.address);
		});

		it('Should set the right amounts', async () => {
			expect(await sportsAMMV2.safeBoxFee()).to.equal(SPORTS_AMM_INITAL_PARAMS.safeBoxFee);
			expect(await sportsAMMV2.minBuyInAmount()).to.equal(SPORTS_AMM_INITAL_PARAMS.minBuyInAmount);
			expect(await sportsAMMV2.maxTicketSize()).to.equal(SPORTS_AMM_INITAL_PARAMS.maxTicketSize);
			expect(await sportsAMMV2.maxSupportedAmount()).to.equal(
				SPORTS_AMM_INITAL_PARAMS.maxSupportedAmount
			);
			expect(await sportsAMMV2.maxSupportedOdds()).to.equal(
				SPORTS_AMM_INITAL_PARAMS.maxSupportedOdds
			);
		});

		it('Should set the right times', async () => {
			expect(await sportsAMMV2.minimalTimeLeftToMaturity()).to.equal(
				SPORTS_AMM_INITAL_PARAMS.minimalTimeLeftToMaturity
			);
			expect(await sportsAMMV2.expiryDuration()).to.equal(SPORTS_AMM_INITAL_PARAMS.expiryDuration);
		});

		it('Should set the right ticket mastercopy', async () => {
			expect(await sportsAMMV2.ticketMastercopy()).to.equal(await ticketMastercopy.getAddress());
		});
		it('Should set the right liquidity pool', async () => {
			expect(await sportsAMMV2.liquidityPool()).to.equal(
				await sportsAMMV2LiquidityPool.getAddress()
			);
		});
	});

	describe('Setters', () => {
		it('Should set the new amounts', async () => {
			const safeBoxFee = ethers.parseEther('0.01');
			const minBuyInAmount = ethers.parseEther('5');
			const maxTicketSize = 15;
			const maxSupportedAmount = ethers.parseEther('30000');
			const maxSupportedOdds = ethers.parseEther('0.001');

			await expect(
				sportsAMMV2
					.connect(secondAccount)
					.setAmounts(
						safeBoxFee,
						minBuyInAmount,
						maxTicketSize,
						maxSupportedAmount,
						maxSupportedOdds
					)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setAmounts(
				safeBoxFee,
				minBuyInAmount,
				maxTicketSize,
				maxSupportedAmount,
				maxSupportedOdds
			);
			expect(await sportsAMMV2.safeBoxFee()).to.equal(safeBoxFee);
			expect(await sportsAMMV2.minBuyInAmount()).to.equal(minBuyInAmount);
			expect(await sportsAMMV2.maxTicketSize()).to.equal(maxTicketSize);
			expect(await sportsAMMV2.maxSupportedAmount()).to.equal(maxSupportedAmount);
			expect(await sportsAMMV2.maxSupportedOdds()).to.equal(maxSupportedOdds);

			await expect(
				sportsAMMV2.setAmounts(
					safeBoxFee,
					minBuyInAmount,
					maxTicketSize,
					maxSupportedAmount,
					maxSupportedOdds
				)
			)
				.to.emit(sportsAMMV2, 'AmountsUpdated')
				.withArgs(safeBoxFee, minBuyInAmount, maxTicketSize, maxSupportedAmount, maxSupportedOdds);
		});

		it('Should set the new times', async () => {
			const minimalTimeLeftToMaturity = 20;
			const expiryDuration = 15552000;

			await expect(
				sportsAMMV2.connect(secondAccount).setTimes(minimalTimeLeftToMaturity, expiryDuration)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setTimes(minimalTimeLeftToMaturity, expiryDuration);
			expect(await sportsAMMV2.minimalTimeLeftToMaturity()).to.equal(minimalTimeLeftToMaturity);
			expect(await sportsAMMV2.expiryDuration()).to.equal(expiryDuration);

			await expect(sportsAMMV2.setTimes(minimalTimeLeftToMaturity, expiryDuration))
				.to.emit(sportsAMMV2, 'TimesUpdated')
				.withArgs(minimalTimeLeftToMaturity, expiryDuration);
		});

		it('Should set the new addresses', async () => {
			const dummyAddress1 = thirdAccount.address;
			const dummyAddress2 = fourthAccount.address;

			await expect(
				sportsAMMV2
					.connect(secondAccount)
					.setAddresses(
						dummyAddress1,
						dummyAddress2,
						dummyAddress1,
						dummyAddress2,
						dummyAddress1,
						dummyAddress2
					)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setAddresses(
				dummyAddress1,
				dummyAddress2,
				dummyAddress1,
				dummyAddress2,
				dummyAddress1,
				dummyAddress2
			);
			expect(await sportsAMMV2.defaultCollateral()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.manager()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.riskManager()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.referrals()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.stakingThales()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.safeBox()).to.equal(dummyAddress2);

			await expect(
				sportsAMMV2.setAddresses(
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2
				)
			)
				.to.emit(sportsAMMV2, 'AddressesUpdated')
				.withArgs(
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2
				);
		});

		it('Should set the new ticket mastercopy', async () => {
			const dummyAddress1 = thirdAccount.address;

			await expect(
				sportsAMMV2.connect(secondAccount).setTicketMastercopy(dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setTicketMastercopy(dummyAddress1);
			expect(await sportsAMMV2.ticketMastercopy()).to.equal(dummyAddress1);

			await expect(sportsAMMV2.setTicketMastercopy(dummyAddress1))
				.to.emit(sportsAMMV2, 'TicketMastercopyUpdated')
				.withArgs(dummyAddress1);
		});
	});

	describe('Quote', () => {
		it('Should get quote', async () => {
			const quote = await sportsAMMV2.tradeQuote(tradeData, BUY_IN_AMOUNT);

			expect(quote.payout).to.equal(ethers.parseEther('14.848484848484848484'));
		});
	});
});
