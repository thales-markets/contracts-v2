const { ethers } = require('hardhat');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const defaultCollateralAddress = getTargetAddress('OvertimePaymentToken', network);
	const mockChainlinkOracleAddress = getTargetAddress('ChainlinkOracle', network);
	// const mockChainlinkOracleAddress = '0xaC69Dcaf76f0EE3aC7e2035825d7765Ebbb654B9';
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);

	const mockSpecId = '0x6435303366646236656233653433613539353665666166636431393532623065';
	const paymentAmount = ethers.parseEther('1');

	const sgpTradingProcessor = await ethers.getContractFactory('SGPTradingProcessor');

	const sgpTradingProcessorDeployed = await sgpTradingProcessor.deploy(
		defaultCollateralAddress,
		mockChainlinkOracleAddress,
		sportsAMMV2Address,
		mockSpecId,
		paymentAmount
	);
	await sgpTradingProcessorDeployed.waitForDeployment();

	const sgpTradingProcessorAddress = await sgpTradingProcessorDeployed.getAddress();

	console.log('SGPTradingProcessor deployed on:', sgpTradingProcessorAddress);
	setTargetAddress('SGPTradingProcessor', network, sgpTradingProcessorAddress);
	await delay(5000);

	// if (isTestNetwork(networkObj.chainId)) {
	// 	const mockChainlinkOracle = await ethers.getContractFactory('MockChainlinkOracle');
	// 	const mockChainlinkOracleDeployed = mockChainlinkOracle.attach(mockChainlinkOracleAddress);
	// 	await mockChainlinkOracleDeployed.setSGPTradingProcessor(sgpTradingProcessorAddress, {
	// 		from: owner.address,
	// 	});
	// 	console.log('SGPTradingProcessor set in MockChainlinkOracle');
	//
	// 	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	// 	const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
	// 	await sportsAMMV2Deployed.setSGPTradingProcessor(sgpTradingProcessorAddress, {
	// 		from: owner.address,
	// 	});
	// 	console.log('SGPTradingProcessor set in SportsAMMV2');
	// }

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sgpTradingProcessorAddress,
			constructorArguments: [
				defaultCollateralAddress,
				mockChainlinkOracleAddress,
				sportsAMMV2Address,
				mockSpecId,
				paymentAmount,
			],
			contract: 'contracts/core/SGPTrading/SGPTradingProcessor.sol:SGPTradingProcessor',
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
