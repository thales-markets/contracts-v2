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
	const houseEdge = ethers.parseEther('0.02'); // 2%

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);
	const callbackGasLimit = 500000;
	const requestConfirmations = 3;
	const nativePayment = false;

	const Dice = await ethers.getContractFactory('Dice');
	const diceDeployed = await upgrades.deployProxy(Dice, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await diceDeployed.waitForDeployment();

	const diceAddress = await diceDeployed.getAddress();

	console.log('Dice deployed on:', diceAddress);
	setTargetAddress('Dice', network, diceAddress);

	await delay(5000);

	await diceDeployed.initialize(
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
		houseEdge,
		{
			subscriptionId: subscriptionId,
			keyHash: keyHash,
			callbackGasLimit: callbackGasLimit,
			requestConfirmations: requestConfirmations,
			nativePayment: nativePayment,
		}
	);
	console.log('Dice initialized');

	await delay(5000);

	const diceImplementationAddress = await getImplementationAddress(ethers.provider, diceAddress);
	console.log('Dice Implementation:', diceImplementationAddress);
	setTargetAddress('DiceImplementation', network, diceImplementationAddress);

	const diceProxyAdminAddress = await getAdminAddress(ethers.provider, diceAddress);
	console.log('Dice Proxy Admin:', diceProxyAdminAddress);
	setTargetAddress('DiceProxyAdmin', network, diceProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: diceAddress,
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
