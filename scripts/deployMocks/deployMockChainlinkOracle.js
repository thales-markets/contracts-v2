const { ethers } = require('hardhat');

const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockChainlinkOracle = await ethers.getContractFactory('MockChainlinkOracle');

	const mockChainlinkOracleDeployed = await mockChainlinkOracle.deploy();
	await mockChainlinkOracleDeployed.waitForDeployment();

	const mockChainlinkOracleAddress = await mockChainlinkOracleDeployed.getAddress();

	console.log('MockChainlinkOracle deployed on:', mockChainlinkOracleAddress);
	setTargetAddress('MockChainlinkOracle', network, mockChainlinkOracleAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockChainlinkOracleAddress,
			contract: 'contracts/utils/test-helpers/MockChainlinkOracle.sol:MockChainlinkOracle',
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
