const { ethers } = require('hardhat');

const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockWETH = await ethers.getContractFactory('MockWETH');

	const mockWETHDeployed = await mockWETH.deploy();
	await mockWETHDeployed.waitForDeployment();

	const mockWETHAddress = await mockWETHDeployed.getAddress();

	console.log('MockWETH deployed on:', mockWETHAddress);
	setTargetAddress('WETH', network, mockWETHAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockWETHAddress,
			contract: 'contracts/utils/test-helpers/MockWETH.sol:MockWETH',
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
