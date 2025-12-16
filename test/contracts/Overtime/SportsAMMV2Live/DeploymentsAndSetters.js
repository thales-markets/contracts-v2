const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const {
	deploySportsAMMV2Fixture,
	deployAccountsFixture,
} = require('../../../utils/fixtures/overtimeFixtures');

describe('SportsAMMV2Live Deployment and Setters', () => {
	let liveTradingProcessor, liveTradingProcessorData, collateral, secondAccount, thirdAccount;

	beforeEach(async () => {
		({ liveTradingProcessor, liveTradingProcessorData, collateral } =
			await loadFixture(deploySportsAMMV2Fixture));
		({ secondAccount, thirdAccount } = await loadFixture(deployAccountsFixture));
	});

	describe('Live Trade', () => {
		it('Setters', async () => {
			await liveTradingProcessor.setPaused(true);
			await liveTradingProcessor.setMaxAllowedExecutionDelay(30);

			const collateralAddress = await collateral.getAddress();
			const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';
			await liveTradingProcessor.setConfiguration(
				collateralAddress, //link
				collateralAddress, //_oracle
				collateralAddress, // _sportsAMM
				mockSpecId, // _specId
				0 // payment
			);
		});
	});

	describe('Live Trade Data', () => {
		it('Should set the new Live Trading Processor', async () => {
			// setLiveTradingProcessor
			await expect(
				liveTradingProcessorData.connect(secondAccount).setLiveTradingProcessor(thirdAccount)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await liveTradingProcessorData.setLiveTradingProcessor(thirdAccount);
			expect(await liveTradingProcessorData.liveTradingProcessor()).to.equal(thirdAccount.address);

			await expect(liveTradingProcessorData.setLiveTradingProcessor(thirdAccount))
				.to.emit(liveTradingProcessorData, 'LiveTradingProcessorChanged')
				.withArgs(thirdAccount.address);

			// setFreeBetsHolder
			await expect(
				liveTradingProcessorData.connect(secondAccount).setFreeBetsHolder(thirdAccount)
			).to.be.revertedWith('Only the contract owner may perform this action');

			await liveTradingProcessorData.setFreeBetsHolder(thirdAccount);
			expect(await liveTradingProcessorData.liveTradingProcessor()).to.equal(thirdAccount.address);

			await expect(liveTradingProcessorData.setFreeBetsHolder(thirdAccount))
				.to.emit(liveTradingProcessorData, 'FreeBetsHolderChanged')
				.withArgs(thirdAccount.address);
		});
	});
});
