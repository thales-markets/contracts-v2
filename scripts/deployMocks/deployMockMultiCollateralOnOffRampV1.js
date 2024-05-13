const { ethers } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);
	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const defaultCollateralAddress = getTargetAddress('DefaultCollateral', network);
	const mockMultiCollateral = await ethers.getContractFactory('MockMultiCollateralOnOffRampV1');

	const mockMultiCollateralDeployed = await upgrades.deployProxy(
		mockMultiCollateral,
		[owner.address, defaultCollateralAddress],
		{ initialOwner: protocolDAOAddress }
	);

	await mockMultiCollateralDeployed.waitForDeployment();

	const mockMultiCollateralAddress = await mockMultiCollateralDeployed.getAddress();

	console.log('MockMultiCollateral deployed on:', mockMultiCollateralAddress);
	setTargetAddress('MockMultiCollateralOnOffRampV1', network, mockMultiCollateralAddress);

	const mockMultiCollateralImplementationAddress = await getImplementationAddress(
		ethers.provider,
		mockMultiCollateralAddress
	);
	console.log(
		'MockMultiCollateralOnOffRampV1 Implementation:',
		mockMultiCollateralImplementationAddress
	);
	setTargetAddress(
		'MockMultiCollateralOnOffRampV1Implementation',
		network,
		mockMultiCollateralImplementationAddress
	);

	i = 1;
	const mockPriceFeedAddress = getTargetAddress('PriceFeed', network);
	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	await mockMultiCollateralDeployed.setPriceFeed(mockPriceFeedAddress);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setSupportedAMM(sportsAMMV2Address, true);
	console.log('tx ', i++);

	const wethAddress = getTargetAddress('WETH', network);
	await mockMultiCollateralDeployed.setWETH(wethAddress);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setSupportedCollateral(wethAddress, true);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setPriceFeedKeyPerAsset(
		ethers.encodeBytes32String('WETH'),
		wethAddress
	);
	console.log('tx ', i++);
	const usdcAddress = getTargetAddress('ExoticUSDC', network);
	await mockMultiCollateralDeployed.setSupportedCollateral(usdcAddress, true);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setPriceFeedKeyPerAsset(
		ethers.encodeBytes32String('USDC'),
		wethAddress
	);
	console.log('tx ', i++);
	const usdtAddress = getTargetAddress('ExoticUSDT', network);
	await mockMultiCollateralDeployed.setSupportedCollateral(usdtAddress, true);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setPriceFeedKeyPerAsset(
		ethers.encodeBytes32String('USDT'),
		wethAddress
	);
	console.log('tx ', i++);
	const susdAddress = getTargetAddress('ExoticUSD', network);
	await mockMultiCollateralDeployed.setSupportedCollateral(susdAddress, true);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setPriceFeedKeyPerAsset(
		ethers.encodeBytes32String('SUSD'),
		wethAddress
	);
	console.log('tx ', i++);
	const thalesAddress = getTargetAddress('Thales', network);
	await mockMultiCollateralDeployed.setSupportedCollateral(thalesAddress, true);
	console.log('tx ', i++);
	await mockMultiCollateralDeployed.setPriceFeedKeyPerAsset(
		ethers.encodeBytes32String('THALES'),
		thalesAddress
	);
	console.log('tx ', i++);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockMultiCollateralAddress,
			contract:
				'contracts/utils/test-helpers/MockMultiCollateralOnOffRampV1.sol:MockMultiCollateralOnOffRampV1',
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
