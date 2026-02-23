// scripts/deployCashoutProcessor.js
const hre = require('hardhat');
const { ethers } = hre;

const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];

	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	// ---- Addresses (same pattern as LiveTradingProcessor deploy) ----
	const linkAddress = getTargetAddress('OvertimePaymentToken', network);
	const chainlinkOracleAddress = getTargetAddress('ChainlinkOracle', network);
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);

	// ---- CashoutProcessor ctor args ----
	//229cae30-7ec6-467c-8f3c-0e4550efcef5
	const cashoutJobSpecId = '0x3232396361653330376563363436376338663363306534353530656663656635';
	const paymentAmount = ethers.parseEther('1');

	// ---- Deploy ----
	const CashoutProcessor = await ethers.getContractFactory('CashoutProcessor');

	const cashoutProcessor = await CashoutProcessor.deploy(
		linkAddress,
		chainlinkOracleAddress,
		sportsAMMV2Address,
		cashoutJobSpecId,
		paymentAmount
	);

	await cashoutProcessor.waitForDeployment();
	const cashoutProcessorAddress = await cashoutProcessor.getAddress();

	console.log('CashoutProcessor deployed on:', cashoutProcessorAddress);
	setTargetAddress('CashoutProcessor', network, cashoutProcessorAddress);

	await delay(5000);

	// Optional wiring (only if you have setters + want it automated)
	// - Your CashoutProcessor uses sportsAMM.cashoutTicketWithLegOdds(...) directly, so AMM already "knows" it exists.
	// - If your SportsAMMV2 has an allowlist / processor setter, wire it here similarly to LiveTradingProcessor.

	// ---- Verify ----
	try {
		await hre.run('verify:verify', {
			address: cashoutProcessorAddress,
			constructorArguments: [
				linkAddress,
				chainlinkOracleAddress,
				sportsAMMV2Address,
				cashoutJobSpecId,
				paymentAmount,
			],
			contract: 'contracts/core/Cashout/CashoutProcessor.sol:CashoutProcessor',
		});
	} catch (e) {
		console.log(e);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
