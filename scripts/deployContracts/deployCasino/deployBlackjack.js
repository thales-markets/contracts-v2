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
	const wethPriceFeedKey = ethers.encodeBytes32String('ETH');
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	const maxProfitUsd = ethers.parseEther('1000');
	const cancelTimeout = 60;

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);
	const callbackGasLimit = 500000;
	const requestConfirmations = 1;
	const nativePayment = false;

	const Blackjack = await ethers.getContractFactory('Blackjack');
	const blackjackDeployed = await upgrades.deployProxy(Blackjack, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await blackjackDeployed.waitForDeployment();

	const blackjackAddress = await blackjackDeployed.getAddress();

	console.log('Blackjack deployed on:', blackjackAddress);
	setTargetAddress('Blackjack', network, blackjackAddress);

	await delay(5000);

	await blackjackDeployed.initialize(
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
	console.log('Blackjack initialized');

	await delay(5000);

	const blackjackImplementationAddress = await getImplementationAddress(
		ethers.provider,
		blackjackAddress
	);
	console.log('Blackjack Implementation:', blackjackImplementationAddress);
	setTargetAddress('BlackjackImplementation', network, blackjackImplementationAddress);

	const blackjackProxyAdminAddress = await getAdminAddress(ethers.provider, blackjackAddress);
	console.log('Blackjack Proxy Admin:', blackjackProxyAdminAddress);
	setTargetAddress('BlackjackProxyAdmin', network, blackjackProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: blackjackAddress,
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
