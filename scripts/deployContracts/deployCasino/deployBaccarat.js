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
	const bankerPayoutMultiplier = 0; // use default 1.95x

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);
	const callbackGasLimit = 500000;
	const requestConfirmations = 3;
	const nativePayment = false;

	const Baccarat = await ethers.getContractFactory('Baccarat');
	const baccaratDeployed = await upgrades.deployProxy(Baccarat, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await baccaratDeployed.waitForDeployment();

	const baccaratAddress = await baccaratDeployed.getAddress();

	console.log('Baccarat deployed on:', baccaratAddress);
	setTargetAddress('Baccarat', network, baccaratAddress);

	await delay(5000);

	await baccaratDeployed.initialize(
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
		bankerPayoutMultiplier,
		{
			subscriptionId: subscriptionId,
			keyHash: keyHash,
			callbackGasLimit: callbackGasLimit,
			requestConfirmations: requestConfirmations,
			nativePayment: nativePayment,
		}
	);
	console.log('Baccarat initialized');

	await delay(5000);

	const baccaratImplementationAddress = await getImplementationAddress(
		ethers.provider,
		baccaratAddress
	);
	console.log('Baccarat Implementation:', baccaratImplementationAddress);
	setTargetAddress('BaccaratImplementation', network, baccaratImplementationAddress);

	const baccaratProxyAdminAddress = await getAdminAddress(ethers.provider, baccaratAddress);
	console.log('Baccarat Proxy Admin:', baccaratProxyAdminAddress);
	setTargetAddress('BaccaratProxyAdmin', network, baccaratProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: baccaratAddress,
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
