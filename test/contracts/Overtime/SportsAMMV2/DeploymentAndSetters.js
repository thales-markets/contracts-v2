const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { expect } = require('chai');
const {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
} = require('../../../utils/fixtures/overtimeFixtures');
const { SPORTS_AMM_INITAL_PARAMS } = require('../../../constants/overtimeContractParams');
const { MAX_NUMBER, ZERO_ADDRESS } = require('../../../constants/general');
const { GAME_ID_1 } = require('../../../constants/overtime');

describe('SportsAMMV2 Deployment and Setters', () => {
	let sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		sportsAMMV2ResultManager,
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
		collateralAddress;

	beforeEach(async () => {
		({
			sportsAMMV2Manager,
			sportsAMMV2RiskManager,
			sportsAMMV2ResultManager,
			sportsAMMV2,
			ticketMastercopy,
			sportsAMMV2LiquidityPool,
			collateral,
			referrals,
			stakingThales,
			safeBox,
			owner,
			collateralAddress,
		} = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount, fourthAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Deployment', () => {
		it('Should set the right owner', async () => {
			expect(await sportsAMMV2.owner()).to.equal(owner.address);
		});

		it('Should set the right addresses', async () => {
			expect(await sportsAMMV2.defaultCollateral()).to.equal(await collateral.getAddress());
			expect(await sportsAMMV2.manager()).to.equal(await sportsAMMV2Manager.getAddress());
			expect(await sportsAMMV2.riskManager()).to.equal(await sportsAMMV2RiskManager.getAddress());
			expect(await sportsAMMV2.resultManager()).to.equal(
				await sportsAMMV2ResultManager.getAddress()
			);
			expect(await sportsAMMV2.referrals()).to.equal(await referrals.getAddress());
			expect(await sportsAMMV2.stakingThales()).to.equal(await stakingThales.getAddress());
			expect(await sportsAMMV2.safeBox()).to.equal(safeBox.address);
		});

		it('Should set the right amounts', async () => {
			expect(await sportsAMMV2.safeBoxFee()).to.equal(SPORTS_AMM_INITAL_PARAMS.safeBoxFee);
		});

		it('Should set the right ticket mastercopy', async () => {
			expect(await sportsAMMV2.ticketMastercopy()).to.equal(await ticketMastercopy.getAddress());
		});
	});

	describe('Setters', () => {
		it('Should set the new amounts', async () => {
			const safeBoxFee = ethers.parseEther('0.01');

			await expect(sportsAMMV2.connect(secondAccount).setAmounts(safeBoxFee)).to.be.revertedWith(
				'Only the contract owner may perform this action'
			);

			await sportsAMMV2.setAmounts(safeBoxFee);
			expect(await sportsAMMV2.safeBoxFee()).to.equal(safeBoxFee);

			await expect(sportsAMMV2.setAmounts(safeBoxFee))
				.to.emit(sportsAMMV2, 'AmountsUpdated')
				.withArgs(safeBoxFee);
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
						dummyAddress2,
						dummyAddress1
					)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setAddresses(
				dummyAddress1,
				dummyAddress2,
				dummyAddress1,
				dummyAddress2,
				dummyAddress1,
				dummyAddress2,
				dummyAddress1
			);
			expect(await sportsAMMV2.defaultCollateral()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.manager()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.riskManager()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.resultManager()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.referrals()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.stakingThales()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.safeBox()).to.equal(dummyAddress1);

			await expect(
				sportsAMMV2.setAddresses(
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2,
					dummyAddress1
				)
			)
				.to.emit(sportsAMMV2, 'AddressesUpdated')
				.withArgs(
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2,
					dummyAddress1,
					dummyAddress2,
					dummyAddress1
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

		it('Should set the new liquidity pool', async () => {
			const dummyAddress1 = thirdAccount.address;

			let curentLpAllowance = await collateral.allowance(
				await sportsAMMV2.getAddress(),
				await sportsAMMV2LiquidityPool.getAddress()
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			await expect(
				sportsAMMV2
					.connect(secondAccount)
					.setLiquidityPoolForCollateral(collateralAddress, dummyAddress1)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setLiquidityPoolForCollateral(collateralAddress, dummyAddress1);
			expect(await sportsAMMV2.liquidityPoolForCollateral(collateralAddress)).to.equal(
				dummyAddress1
			);

			curentLpAllowance = await collateral.allowance(await sportsAMMV2.getAddress(), dummyAddress1);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			const oldLpAllowance = await collateral.allowance(
				await sportsAMMV2.getAddress(),
				await sportsAMMV2LiquidityPool.getAddress()
			);
			expect(oldLpAllowance).to.equal(0);
		});

		it('Should set the new multi-collateral on/off ramp', async () => {
			const dummyAddress1 = thirdAccount.address;
			const dummyAddress2 = fourthAccount.address;

			// expect(await sportsAMMV2.multiCollateralOnOffRamp()).to.equal(ZERO_ADDRESS);
			// expect(await sportsAMMV2.multicollateralEnabled()).to.equal(false);

			await expect(
				sportsAMMV2.connect(secondAccount).setMultiCollateralOnOffRamp(dummyAddress1, true)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await sportsAMMV2.setMultiCollateralOnOffRamp(dummyAddress1, true);
			expect(await sportsAMMV2.multiCollateralOnOffRamp()).to.equal(dummyAddress1);
			expect(await sportsAMMV2.multicollateralEnabled()).to.equal(true);

			let curentLpAllowance = await collateral.allowance(
				await sportsAMMV2.getAddress(),
				dummyAddress1
			);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			await sportsAMMV2.setMultiCollateralOnOffRamp(dummyAddress2, false);
			expect(await sportsAMMV2.multiCollateralOnOffRamp()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.multicollateralEnabled()).to.equal(false);

			curentLpAllowance = await collateral.allowance(await sportsAMMV2.getAddress(), dummyAddress2);
			expect(curentLpAllowance).to.equal(0);

			const oldLpAllowance = await collateral.allowance(
				await sportsAMMV2.getAddress(),
				dummyAddress1
			);
			expect(oldLpAllowance).to.equal(0);

			await sportsAMMV2.setMultiCollateralOnOffRamp(dummyAddress2, true);
			expect(await sportsAMMV2.multiCollateralOnOffRamp()).to.equal(dummyAddress2);
			expect(await sportsAMMV2.multicollateralEnabled()).to.equal(true);

			curentLpAllowance = await collateral.allowance(await sportsAMMV2.getAddress(), dummyAddress2);
			expect(curentLpAllowance).to.equal(MAX_NUMBER);

			await expect(sportsAMMV2.setMultiCollateralOnOffRamp(dummyAddress1, true))
				.to.emit(sportsAMMV2, 'SetMultiCollateralOnOffRamp')
				.withArgs(dummyAddress1, true);
		});

		it('Should set the new root per game', async () => {
			const newRoot = '0x0ed8693864a15cd5d424428f9fa9454b8f1a8cd22c82016c214204edc9251978';

			await expect(
				sportsAMMV2.connect(secondAccount).setRootsPerGames([GAME_ID_1], [newRoot])
			).to.be.revertedWith('Invalid sender');

			await sportsAMMV2.setRootsPerGames([GAME_ID_1], [newRoot]);
			expect(await sportsAMMV2.rootPerGame(GAME_ID_1)).to.equal(newRoot);

			await expect(sportsAMMV2.setRootsPerGames([GAME_ID_1], [newRoot]))
				.to.emit(sportsAMMV2, 'GameRootUpdated')
				.withArgs(GAME_ID_1, newRoot);
		});

		it('Should set paused', async () => {
			await expect(sportsAMMV2.connect(secondAccount).setPaused(true)).to.be.revertedWith(
				'Only the contract owner may perform this action'
			);

			await sportsAMMV2.setPaused(true);
			expect(await sportsAMMV2.paused()).to.equal(true);
		});

		it('Should set unpaused', async () => {
			await sportsAMMV2.setPaused(true);
			expect(await sportsAMMV2.paused()).to.equal(true);

			await sportsAMMV2.setPaused(false);
			expect(await sportsAMMV2.paused()).to.equal(false);
		});
	});
});
