const { expect } = require('chai');
const { loadFixture, time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

describe('CashoutProcessor Deployment and Setters', () => {
	let cashoutProcessor, collateral, secondAccount, thirdAccount;

	beforeEach(async () => {
		({ cashoutProcessor, collateral } = await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Cashout Processor', () => {
		it('Setters', async () => {
			// pause/unpause
			await cashoutProcessor.setPaused(true);
			await cashoutProcessor.setPaused(false);

			// setMaxAllowedExecutionDelay
			await cashoutProcessor.setMaxAllowedExecutionDelay(30);
			expect(await cashoutProcessor.maxAllowedExecutionDelay()).to.equal(30n);

			// setConfiguration
			const collateralAddress = await collateral.getAddress();
			const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';

			await expect(
				cashoutProcessor.setConfiguration(
					collateralAddress, // link
					collateralAddress, // oracle
					collateralAddress, // sportsAMM
					mockSpecId, // jobSpecId
					0 // payment
				)
			)
				.to.emit(cashoutProcessor, 'ContextReset')
				.withArgs(collateralAddress, collateralAddress, collateralAddress, mockSpecId, 0);

			expect(await cashoutProcessor.sportsAMM()).to.equal(collateralAddress);
			expect(await cashoutProcessor.jobSpecId()).to.equal(mockSpecId);
			expect(await cashoutProcessor.paymentAmount()).to.equal(0n);
		});

		it('Only owner can call admin setters', async () => {
			const collateralAddress = await collateral.getAddress();
			const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';

			// Ownable custom error in OZ v5 is OwnableUnauthorizedAccount(address)
			await expect(cashoutProcessor.connect(secondAccount).setPaused(true)).to.be.reverted;
			await expect(cashoutProcessor.connect(secondAccount).setMaxAllowedExecutionDelay(30)).to.be
				.reverted;

			await expect(
				cashoutProcessor
					.connect(secondAccount)
					.setConfiguration(collateralAddress, collateralAddress, collateralAddress, mockSpecId, 0)
			).to.be.reverted;

			await expect(cashoutProcessor.connect(secondAccount).setFreeBetsHolder(thirdAccount)).to.be
				.reverted;

			// owner ok
			await cashoutProcessor.setFreeBetsHolder(thirdAccount);
			expect(await cashoutProcessor.freeBetsHolder()).to.equal(thirdAccount.address);
		});

		it('Emits SetMaxAllowedExecutionDelay and SetFreeBetsHolder', async () => {
			await expect(cashoutProcessor.setMaxAllowedExecutionDelay(45))
				.to.emit(cashoutProcessor, 'SetMaxAllowedExecutionDelay')
				.withArgs(45);

			await expect(cashoutProcessor.setFreeBetsHolder(thirdAccount))
				.to.emit(cashoutProcessor, 'SetFreeBetsHolder')
				.withArgs(thirdAccount.address);
		});
	});
});
