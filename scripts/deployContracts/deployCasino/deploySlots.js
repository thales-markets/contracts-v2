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

	// ============================================================
	// 5 symbols with balanced weights + pair AND triple payouts
	// ============================================================
	// Weights: [34, 26, 18, 13, 9] (sum 100)
	//   p = [0.34, 0.26, 0.18, 0.13, 0.09]
	//   Σ p² = 0.2406    Σ p³ = 0.065638
	//   Pair hit rate (R1=R2 or R2=R3, excluding triples): 2Σp² - 2Σp³ = 0.349924 → 34.99%
	//   Triple hit rate:                                   Σp³         = 0.065638 →  6.56%
	//   Total hit rate:                                    2Σp² - Σp³  = 0.415562 → 41.56% (~1 in 2.41)
	//
	// Pair raw payouts   [0.5, 0.75, 1.0, 1.25, 1.75]   → total returns [1.49x, 1.735x, 1.98x, 2.225x, 2.715x]
	// Triple raw payouts [2, 4, 10, 20, 38]             → total returns [2.96x, 4.92x, 10.80x, 20.60x, 38.24x]
	//
	// Min win: 1.49x stake (49% profit, no LDW-style fakery)
	// Max win: 38.24x stake (jackpot triple ≈ 1 in 1,372)
	// Every triple > every pair (max pair 2.715 < min triple 2.96)
	//
	// RTP ≈ 95.05%   Effective house edge ≈ 4.95%
	// ============================================================
	const symbolCount = 5;
	const symbolWeights = [34, 26, 18, 13, 9];
	await slotsDeployed.setSymbols(symbolCount, symbolWeights);
	console.log('Symbols configured');

	await delay(5000);

	// Pair payouts (raw multipliers in 1e18, before house edge)
	const pairPayouts = [
		ethers.parseEther('0.5'), // symbol 0 (common):  0.5x  → total return 1.49x
		ethers.parseEther('0.75'), // symbol 1:           0.75x → total return 1.735x
		ethers.parseEther('1'), // symbol 2:           1x    → total return 1.98x
		ethers.parseEther('1.25'), // symbol 3:           1.25x → total return 2.225x
		ethers.parseEther('1.75'), // symbol 4 (jackpot): 1.75x → total return 2.715x
	];
	for (let i = 0; i < pairPayouts.length; i++) {
		await slotsDeployed.setPairPayout(i, pairPayouts[i]);
		console.log(`Pair payout for symbol ${i} set to ${ethers.formatEther(pairPayouts[i])}x`);
		await delay(3000);
	}

	// Triple payouts (raw multipliers in 1e18, before house edge)
	const triplePayouts = [
		ethers.parseEther('2'), // symbol 0 (common):  2x  → total return 2.96x
		ethers.parseEther('4'), // symbol 1:           4x  → total return 4.92x
		ethers.parseEther('10'), // symbol 2:          10x  → total return 10.80x
		ethers.parseEther('20'), // symbol 3:          20x  → total return 20.60x
		ethers.parseEther('38'), // symbol 4 (jackpot): 38x → total return 38.24x
	];
	for (let i = 0; i < triplePayouts.length; i++) {
		await slotsDeployed.setTriplePayout(i, triplePayouts[i]);
		console.log(`Triple payout for symbol ${i} set to ${ethers.formatEther(triplePayouts[i])}x`);
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
