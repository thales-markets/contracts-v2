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
	const maxPayoutMultiplier = ethers.parseEther('50'); // 50x max reserved profit

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);
	const callbackGasLimit = 500000;
	const requestConfirmations = 3;
	const nativePayment = false;

	const Slots = await ethers.getContractFactory('Slots');
	const slotsDeployed = await upgrades.deployProxy(Slots, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await slotsDeployed.waitForDeployment();

	const slotsAddress = await slotsDeployed.getAddress();

	console.log('Slots deployed on:', slotsAddress);
	setTargetAddress('Slots', network, slotsAddress);

	await delay(5000);

	await slotsDeployed.initialize(
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
		maxPayoutMultiplier,
		{
			subscriptionId: subscriptionId,
			keyHash: keyHash,
			callbackGasLimit: callbackGasLimit,
			requestConfirmations: requestConfirmations,
			nativePayment: nativePayment,
		}
	);
	console.log('Slots initialized');

	await delay(5000);

	// Configure symbols: 5 symbols with equal weights
	const symbolCount = 5;
	const symbolWeights = [20, 20, 20, 20, 20];
	await slotsDeployed.setSymbols(symbolCount, symbolWeights);
	console.log('Symbols configured');

	await delay(5000);

	// Configure triple payouts (raw multipliers in 1e18, before house edge)
	const triplePayouts = [
		ethers.parseEther('2'), // symbol 0: 2x
		ethers.parseEther('5'), // symbol 1: 5x
		ethers.parseEther('10'), // symbol 2: 10x
		ethers.parseEther('20'), // symbol 3: 20x
		ethers.parseEther('50'), // symbol 4: 50x (jackpot)
	];
	for (let i = 0; i < triplePayouts.length; i++) {
		await slotsDeployed.setTriplePayout(i, triplePayouts[i]);
		console.log(`Triple payout for symbol ${i} set to ${triplePayouts[i]}`);
		await delay(3000);
	}

	const slotsImplementationAddress = await getImplementationAddress(ethers.provider, slotsAddress);
	console.log('Slots Implementation:', slotsImplementationAddress);
	setTargetAddress('SlotsImplementation', network, slotsImplementationAddress);

	const slotsProxyAdminAddress = await getAdminAddress(ethers.provider, slotsAddress);
	console.log('Slots Proxy Admin:', slotsProxyAdminAddress);
	setTargetAddress('SlotsProxyAdmin', network, slotsProxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: slotsAddress,
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
