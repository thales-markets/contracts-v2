// scripts/deployCashoutProcessor.js
const hre = require('hardhat');
const { ethers } = hre;

const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];

	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const isTestnet = isTestNetwork(networkObj.chainId);

	// ---- Addresses (from deployments) ----
	// Keeping your existing naming: you store LINK-like token as OvertimePaymentToken on this net
	const linkAddress = getTargetAddress('OvertimePaymentToken', network);
	const chainlinkOracleAddress = getTargetAddress('ChainlinkOracle', network);
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);

	// used for wiring on SportsAMM
	const liveTradingProcessorAddress = getTargetAddress('LiveTradingProcessor', network);
	const sgpTradingProcessorAddress = getTargetAddress('SGPTradingProcessor', network);
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);

	// ---- CashoutProcessor ctor args ----
	// 229cae30-7ec6-467c-8f3c-0e4550efcef5
	const cashoutJobSpecId = '0x3232396361653330376563363436376338663363306534353530656663656635';
	const paymentAmount = ethers.parseEther('0.01');

	// ---- Read previous CashoutProcessor (if exists) BEFORE overwriting deployments ----
	let previousCashoutProcessorAddress;
	try {
		previousCashoutProcessorAddress = getTargetAddress('CashoutProcessor', network);
		if (
			!previousCashoutProcessorAddress ||
			previousCashoutProcessorAddress === ethers.ZeroAddress
		) {
			previousCashoutProcessorAddress = undefined;
		}
	} catch (e) {
		previousCashoutProcessorAddress = undefined;
	}

	if (previousCashoutProcessorAddress) {
		console.log('Previous CashoutProcessor:', previousCashoutProcessorAddress);
	} else {
		console.log('No previous CashoutProcessor found in deployments for:', network);
	}

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

	// ============================
	// Testnet-only post deploy init
	// ============================
	if (isTestnet) {
		console.log('Test network: running post-deploy initialization');

		// 1) setFreeBetsHolder in CashoutProcessor
		try {
			const tx = await cashoutProcessor.setFreeBetsHolder(freeBetsHolderAddress);
			await tx.wait();
			console.log('CashoutProcessor.setFreeBetsHolder ->', freeBetsHolderAddress);
		} catch (e) {
			console.log('WARN: setFreeBetsHolder failed (missing method or reverted):', e?.message || e);
		}

		// 2) Move LINK funds from previous CashoutProcessor to new one (if old exists)
		// Uses your added method:
		// withdrawCollateral(address collateral, address recipient) external onlyOwner
		if (previousCashoutProcessorAddress) {
			try {
				const link = await ethers.getContractAt(
					['function balanceOf(address) view returns (uint256)'],
					linkAddress
				);
				const oldBal = await link.balanceOf(previousCashoutProcessorAddress);

				if (oldBal > 0n) {
					console.log('Old CashoutProcessor LINK balance:', oldBal.toString());

					const old = await ethers.getContractAt(
						['function withdrawCollateral(address collateral, address recipient) external'],
						previousCashoutProcessorAddress
					);

					const tx = await old.withdrawCollateral(linkAddress, cashoutProcessorAddress);
					await tx.wait();
					console.log('Moved LINK via old.withdrawCollateral ->', cashoutProcessorAddress);
				} else {
					console.log('Old CashoutProcessor LINK balance is 0, skipping move.');
				}
			} catch (e) {
				console.log('WARN: moving LINK from old CashoutProcessor failed:', e?.message || e);
			}
		}

		// 3) set betting processors in SportsAMM (read from deployments)
		try {
			const sportsAMM = await ethers.getContractAt(
				['function setBettingProcessors(address,address,address,address) external'],
				sportsAMMV2Address
			);

			const tx = await sportsAMM.setBettingProcessors(
				liveTradingProcessorAddress,
				sgpTradingProcessorAddress,
				freeBetsHolderAddress,
				cashoutProcessorAddress
			);
			await tx.wait();

			console.log('SportsAMM.setBettingProcessors ->', {
				liveTradingProcessorAddress,
				sgpTradingProcessorAddress,
				freeBetsHolderAddress,
				cashoutProcessorAddress,
			});
		} catch (e) {
			console.log('WARN: SportsAMM.setBettingProcessors failed:', e?.message || e);
		}
	} else {
		console.log('Not a test network: skipping testnet-only initialization steps.');
	}

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
