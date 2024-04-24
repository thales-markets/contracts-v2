const { ethers } = require('hardhat');

const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockAddressManager = await ethers.getContractFactory('MockAddressManager');

	const mockAddressManagerDeployed = await mockAddressManager.deploy();
	await mockAddressManagerDeployed.waitForDeployment();

	const mockAddressManagerAddress = await mockAddressManagerDeployed.getAddress();

	console.log('MockAddressManager deployed on:', mockAddressManagerAddress);
	setTargetAddress('AddressManager', network, mockAddressManagerAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockAddressManagerAddress,
			contract: 'contracts/utils/test-helpers/MockAddressManager.sol:MockAddressManager',
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
