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

	// Configure symbols: 3 tiers with skewed weights (industry-standard weighted reels).
	// Hit rate: 0.62³ + 0.28³ + 0.10³ ≈ 26.13% (1 in ~3.8 spins)
	const symbolCount = 3;
	const symbolWeights = [62, 28, 10];
	await slotsDeployed.setSymbols(symbolCount, symbolWeights);
	console.log('Symbols configured');

	await delay(5000);

	// Triple payouts (raw multipliers in 1e18, before house edge).
	// Every win is ≥ 2.96x stake (no "small losing wins").
	// RTP = Σ pᵢ × (1 + 0.98 × rawᵢ) ≈ 89.96% → house edge ≈ 10.04%
	const triplePayouts = [
		ethers.parseEther('2'), // symbol 0 (common):  2x → total return 2.96x
		ethers.parseEther('6'), // symbol 1 (mid):     6x → total return 6.88x
		ethers.parseEther('43'), // symbol 2 (jackpot): 43x → total return 43.14x
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
