const { ethers } = require('hardhat');

const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const wethAddress = getTargetAddress('WETH', network);
	const usdcAddress = getTargetAddress('ExoticUSDC', network);
	const usdtAddress = getTargetAddress('ExoticUSDT', network);
	const susdAddress = getTargetAddress('ExoticUSD', network);
	const thalesAddress = getTargetAddress('Thales', network);

	const feedKeys = [
		ethers.encodeBytes32String('WETH'),
		ethers.encodeBytes32String('USDC'),
		ethers.encodeBytes32String('USDT'),
		ethers.encodeBytes32String('SUSD'),
		ethers.encodeBytes32String('THALES'),
	];
	const feedAddresses = [wethAddress, usdcAddress, usdtAddress, susdAddress, thalesAddress];

	const feedPrices = [
		ethers.parseEther('3500'),
		ethers.parseEther('1'),
		ethers.parseEther('1'),
		ethers.parseEther('1'),
		ethers.parseEther('0.3'),
	];

	const mockPriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const mockPriceFeedAddress = getTargetAddress('PriceFeed', network);
	const mockPriceFeedDeployed = mockPriceFeed.attach(mockPriceFeedAddress);
	const mockMultiCollateral = await ethers.getContractFactory('MockMultiCollateralOnOffRamp');
	const mockMultiCollateralAddress = getTargetAddress('MultiCollateral', network);
	const mockMultiCollateraldDeployed = mockMultiCollateral.attach(mockMultiCollateralAddress);

	for (let i = 0; i < feedKeys.length; i++) {
		await delay(1000);
		await mockPriceFeedDeployed.setPriceFeedForCollateral(
			feedKeys[i],
			feedAddresses[i],
			feedPrices[i]
		);
		await mockMultiCollateraldDeployed.setCollateralKey(feedAddresses[i], feedKeys[i]);
		console.log('Set for key: ', feedKeys[i]);
	}

	await mockPriceFeedDeployed.setWETH9(wethAddress);
	console.log('WETH set');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
