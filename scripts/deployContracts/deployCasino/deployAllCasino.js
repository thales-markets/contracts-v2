const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const managerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	const wethPriceFeedKey = ethers.encodeBytes32String('WETH');
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);

	const coreAddresses = {
		owner: owner.address,
		manager: managerAddress,
		priceFeed: priceFeedAddress,
		vrfCoordinator: vrfCoordinatorAddress,
	};

	const collateralConfig = {
		usdc: usdcAddress,
		weth: wethAddress,
		over: overAddress,
		wethPriceFeedKey,
		overPriceFeedKey,
	};

	const vrfConfig = {
		subscriptionId,
		keyHash,
		callbackGasLimit: 500000,
		requestConfirmations: 3,
		nativePayment: false,
	};

	const maxProfitUsd = ethers.parseEther('1000');
	const cancelTimeout = 60;

	// Add VRF consumer helper
	const vrfAbi = ['function addConsumer(uint256 subId, address consumer) external'];
	const vrf = new ethers.Contract(vrfCoordinatorAddress, vrfAbi, owner);

	async function deployAndInit(name, initFn) {
		const Factory = await ethers.getContractFactory(name);
		const proxy = await upgrades.deployProxy(Factory, [], {
			initializer: false,
			initialOwner: protocolDAOAddress,
		});
		await proxy.waitForDeployment();
		const addr = await proxy.getAddress();
		console.log(`\n${name} deployed: ${addr}`);
		setTargetAddress(name, network, addr);
		await delay(5000);

		await initFn(proxy);
		console.log(`${name} initialized`);
		await delay(3000);

		// Add as VRF consumer
		await vrf.addConsumer(subscriptionId, addr);
		console.log(`${name} added as VRF consumer`);
		await delay(3000);

		const impl = await getImplementationAddress(ethers.provider, addr);
		setTargetAddress(`${name}Implementation`, network, impl);
		const proxyAdmin = await getAdminAddress(ethers.provider, addr);
		setTargetAddress(`${name}ProxyAdmin`, network, proxyAdmin);

		// Verify
		try {
			await hre.run('verify:verify', { address: impl });
		} catch (e) {
			console.log(`${name} verify:`, e.message?.slice(0, 80) || e);
		}
		await delay(3000);

		return proxy;
	}

	// ==================== DICE ====================
	await deployAndInit('Dice', async (dice) => {
		await dice.initialize(
			coreAddresses,
			collateralConfig,
			maxProfitUsd,
			cancelTimeout,
			ethers.parseEther('0.02'), // houseEdge 2%
			vrfConfig
		);
	});

	// ==================== ROULETTE ====================
	await deployAndInit('Roulette', async (roulette) => {
		await roulette.initialize(
			coreAddresses,
			collateralConfig,
			maxProfitUsd,
			cancelTimeout,
			vrfConfig
		);
	});

	// ==================== BLACKJACK ====================
	await deployAndInit('Blackjack', async (blackjack) => {
		await blackjack.initialize(
			coreAddresses,
			collateralConfig,
			maxProfitUsd,
			cancelTimeout,
			vrfConfig
		);
	});

	// ==================== BACCARAT ====================
	await deployAndInit('Baccarat', async (baccarat) => {
		await baccarat.initialize(
			coreAddresses,
			collateralConfig,
			maxProfitUsd,
			cancelTimeout,
			0, // use DEFAULT_BANKER_PAYOUT (1.95x)
			vrfConfig
		);
	});

	// ==================== SLOTS ====================
	const slots = await deployAndInit('Slots', async (s) => {
		await s.initialize(
			coreAddresses,
			collateralConfig,
			maxProfitUsd,
			cancelTimeout,
			ethers.parseEther('0.02'), // houseEdge 2%
			ethers.parseEther('50'), // maxPayoutMultiplier 50x
			vrfConfig
		);
	});

	// Configure Slots: 5 symbols, balanced weights, pair + triple payouts.
	// See deploySlots.js for full math (hit rate ~41.56%, RTP ~95.05%).
	await delay(3000);
	await slots.setSymbols(5, [34, 26, 18, 13, 9]);
	console.log('Slots symbols configured');
	await delay(3000);

	const pairPayouts = [
		ethers.parseEther('0.5'),
		ethers.parseEther('0.75'),
		ethers.parseEther('1'),
		ethers.parseEther('1.25'),
		ethers.parseEther('1.75'),
	];
	for (let i = 0; i < pairPayouts.length; i++) {
		await slots.setPairPayout(i, pairPayouts[i]);
		console.log(`Slots pair payout[${i}] = ${ethers.formatEther(pairPayouts[i])}x`);
		await delay(3000);
	}

	const triplePayouts = [
		ethers.parseEther('2'),
		ethers.parseEther('4'),
		ethers.parseEther('10'),
		ethers.parseEther('20'),
		ethers.parseEther('38'),
	];
	for (let i = 0; i < triplePayouts.length; i++) {
		await slots.setTriplePayout(i, triplePayouts[i]);
		console.log(`Slots triple payout[${i}] = ${ethers.formatEther(triplePayouts[i])}x`);
		await delay(3000);
	}

	// ==================== FUND BANKROLLS ====================
	console.log('\n--- Funding bankrolls ---');
	const usdc = await ethers.getContractAt('IERC20', usdcAddress);
	const fundAmount = ethers.parseUnits('500', 6);

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const bal = await usdc.balanceOf(addr);
		if (bal < fundAmount) {
			await usdc.transfer(addr, fundAmount);
			console.log(`${name}: funded with 500 USDC`);
			await delay(3000);
		} else {
			console.log(`${name}: already has ${ethers.formatUnits(bal, 6)} USDC`);
		}
	}

	console.log('\n=== All casino contracts deployed and configured ===');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
