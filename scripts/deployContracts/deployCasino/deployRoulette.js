const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	const wethPriceFeedKey = ethers.encodeBytes32String('WETH');
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	const maxProfitUsd = ethers.parseEther('1000');
	const cancelTimeout = 60;

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);
	const callbackGasLimit = 200000;
	const requestConfirmations = 3;
	const nativePayment = false;

	const Roulette = await ethers.getContractFactory('Roulette');
	const rouletteDeployed = await upgrades.deployProxy(Roulette, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await rouletteDeployed.waitForDeployment();

	const rouletteAddress = await rouletteDeployed.getAddress();

	console.log('Roulette deployed on:', rouletteAddress);
	setTargetAddress('Roulette', network, rouletteAddress);

	await delay(5000);

	await rouletteDeployed.initialize(
		{
			owner: owner.address,
			manager: sportsAMMV2ManagerAddress,
			priceFeed: priceFeedAddress,
			vrfCoordinator: vrfCoordinatorAddress,
		},
		{
			usdc: usdcAddress,
			weth: wethAddress,
			over: overAddress,
			wethPriceFeedKey: wethPriceFeedKey,
			overPriceFeedKey: overPriceFeedKey,
		},
		maxProfitUsd,
		cancelTimeout,
		{
			subscriptionId: subscriptionId,
			keyHash: keyHash,
			callbackGasLimit: callbackGasLimit,
			requestConfirmations: requestConfirmations,
			nativePayment: nativePayment,
		}
	);
	console.log('Roulette initialized');

	await delay(5000);

	const rouletteImplementationAddress = await getImplementationAddress(
		ethers.provider,
		rouletteAddress
	);
	console.log('Roulette Implementation:', rouletteImplementationAddress);
	setTargetAddress('RouletteImplementation', network, rouletteImplementationAddress);

	const rouletteProxyAdminAddress = await getAdminAddress(ethers.provider, rouletteAddress);
	console.log('Roulette Proxy Admin:', rouletteProxyAdminAddress);
	setTargetAddress('RouletteProxyAdmin', network, rouletteProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: rouletteAddress,
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
