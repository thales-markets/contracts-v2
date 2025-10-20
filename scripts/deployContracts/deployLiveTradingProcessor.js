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

	const mockSpecId = '0x6431653939363663346238643438373838633563376333396235633838353264';
	const paymentAmount = ethers.parseEther('1');

	const liveTradingProcessor = await ethers.getContractFactory('LiveTradingProcessor');

	const liveTradingProcessorDeployed = await liveTradingProcessor.deploy(
		defaultCollateralAddress,
		mockChainlinkOracleAddress,
		sportsAMMV2Address,
		mockSpecId,
		paymentAmount
	);
	await liveTradingProcessorDeployed.waitForDeployment();

	const liveTradingProcessorAddress = await liveTradingProcessorDeployed.getAddress();

	console.log('LiveTradingProcessor deployed on:', liveTradingProcessorAddress);
	setTargetAddress('LiveTradingProcessor', network, liveTradingProcessorAddress);
	await delay(5000);

	// if (isTestNetwork(networkObj.chainId)) {
	// 	const mockChainlinkOracle = await ethers.getContractFactory('MockChainlinkOracle');
	// 	const mockChainlinkOracleDeployed = mockChainlinkOracle.attach(mockChainlinkOracleAddress);
	// 	await mockChainlinkOracleDeployed.setLiveTradingProcessor(liveTradingProcessorAddress, {
	// 		from: owner.address,
	// 	});
	// 	console.log('LiveTradingProcessor set in MockChainlinkOracle');
	//
	// 	const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	// 	const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
	// 	await sportsAMMV2Deployed.setLiveTradingProcessor(liveTradingProcessorAddress, {
	// 		from: owner.address,
	// 	});
	// 	console.log('LiveTradingProcessor set in SportsAMMV2');
	// }

	//await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: liveTradingProcessorAddress,
			constructorArguments: [
				defaultCollateralAddress,
				mockChainlinkOracleAddress,
				sportsAMMV2Address,
				mockSpecId,
				paymentAmount,
			],
			contract: 'contracts/core/LiveTrading/LiveTradingProcessor.sol:LiveTradingProcessor',
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
