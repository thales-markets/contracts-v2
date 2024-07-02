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
	// const mockChainlinkOracleAddress = getTargetAddress('MockChainlinkOracle', network);
	const mockChainlinkOracleAddress = '0xaC69Dcaf76f0EE3aC7e2035825d7765Ebbb654B9';
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	const sportsAMMV2ResultManagerAddress = getTargetAddress('SportsAMMV2ResultManager', network);

	const mockSpecId = '0x6131313939363663346238643438373838633563376333396235633838353264';
	const paymentAmount = ethers.parseEther('1');

	const chainlinkResolver = await ethers.getContractFactory('ChainlinkResolver');

	const chainlinkResolverDeployed = await chainlinkResolver.deploy(
		defaultCollateralAddress,
		mockChainlinkOracleAddress,
		sportsAMMV2Address,
		sportsAMMV2ResultManagerAddress,
		mockSpecId,
		paymentAmount
	);
	await chainlinkResolverDeployed.waitForDeployment();

	const chainlinkResolverAddress = await chainlinkResolverDeployed.getAddress();

	console.log('ChainlinkResolver deployed on:', chainlinkResolverAddress);
	setTargetAddress('ChainlinkResolver', network, chainlinkResolverAddress);
	await delay(5000);

	// if (isTestNetwork(networkObj.chainId)) {
	// const mockChainlinkOracle = await ethers.getContractFactory('MockChainlinkOracle');
	// const mockChainlinkOracleDeployed = mockChainlinkOracle.attach(mockChainlinkOracleAddress);
	// await mockChainlinkOracleDeployed.setChainlinkResolver(chainlinkResolverAddress, {
	// 	from: owner.address,
	// });
	// console.log('ChainlinkResolver set in MockChainlinkOracle');

	const sportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManagerDeployed = sportsAMMV2ResultManager.attach(
		sportsAMMV2ResultManagerAddress
	);
	await sportsAMMV2ResultManagerDeployed.setChainlinkResolver(chainlinkResolverAddress, {
		from: owner.address,
	});
	console.log('ChainlinkResolver set in SportsAMMV2ResultManager');
	// }

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: chainlinkResolverAddress,
			constructorArguments: [
				defaultCollateralAddress,
				mockChainlinkOracleAddress,
				sportsAMMV2Address,
				sportsAMMV2ResultManagerAddress,
				mockSpecId,
				paymentAmount,
			],
			contract: 'contracts/core/Resolving/ChainlinkResolver.sol:ChainlinkResolver',
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
