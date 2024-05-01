const { ethers } = require('hardhat');

const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockPositionalManager = await ethers.getContractFactory('MockPositionalManager');

	const mockPositionalManagerDeployed = await mockPositionalManager.deploy();
	await mockPositionalManagerDeployed.waitForDeployment();

	const mockPositionalManagerAddress = await mockPositionalManagerDeployed.getAddress();

	console.log('MockPositionalManager deployed on:', mockPositionalManagerAddress);
	setTargetAddress('MockPositionalManager', network, mockPositionalManagerAddress);

	await mockPositionalManagerDeployed.setTransformingCollateral(true);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockPositionalManagerAddress,
			contract: 'contracts/utils/test-helpers/MockPositionalManager.sol:MockPositionalManager',
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
