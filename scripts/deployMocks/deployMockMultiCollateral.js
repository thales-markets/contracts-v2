const { ethers } = require('hardhat');

const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockMultiCollateral = await ethers.getContractFactory('MockMultiCollateralOnOffRamp');

	const mockMultiCollateralDeployed = await mockMultiCollateral.deploy();
	await mockMultiCollateralDeployed.waitForDeployment();

	const mockMultiCollateralAddress = await mockMultiCollateralDeployed.getAddress();

	console.log('MockMultiCollateral deployed on:', mockMultiCollateralAddress);
	setTargetAddress('MultiCollateral', network, mockMultiCollateralAddress);

	const mockPriceFeedAddress = getTargetAddress('PriceFeed', network);
	const defaultCollateralAddress = getTargetAddress('DefaultCollateral', network);
	await mockMultiCollateralDeployed.setSUSD(defaultCollateralAddress);
	await mockMultiCollateralDeployed.setPriceFeed(mockPriceFeedAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockMultiCollateralAddress,
			contract: 'contracts/utils/test-helpers/MockMultiCollateral.sol:MockMultiCollateralOnOffRamp',
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
