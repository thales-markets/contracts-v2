const { ethers } = require('hardhat');

const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockUniswap = await ethers.getContractFactory('MockUniswap');

	const mockUniswapDeployed = await mockUniswap.deploy();
	await mockUniswapDeployed.waitForDeployment();

	const mockUniswapAddress = await mockUniswapDeployed.getAddress();

	console.log('MockUniswap deployed on:', mockUniswapAddress);
	setTargetAddress('MockUniswap', network, mockUniswapAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockUniswapAddress,
			contract: 'contracts/utils/test-helpers/MockUniswap.sol:MockUniswap',
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
