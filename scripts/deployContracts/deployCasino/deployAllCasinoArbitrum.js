const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

/**
 * Arbitrum casino deploy: mirrors optimisticEthereum game-by-game.
 * Proxy admin = deployer EOA (no initialOwner override → OZ default).
 *   - Dice       : maxProfitUsd=1000, houseEdge=2%
 *   - Roulette   : maxProfitUsd=300  (new worst-case-liability logic)
 *   - Blackjack  : maxProfitUsd=300
 *   - Baccarat   : maxProfitUsd=300  (default banker payout 1.95x)
 *   - Slots      : maxProfitUsd=300, houseEdge=2%, maxPayoutMultiplier=50x
 *                  + symbols [34,26,18,13,9] and pair/triple payouts matching OP
 *
 * VRF: uses ETH native payment, 2-gwei key hash, callback 500k, conf 1.
 */
async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network, '(chain', networkObj.chainId.toString() + ')');

	const managerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);
	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	const wethPriceFeedKey = ethers.encodeBytes32String('ETH');
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
		requestConfirmations: 1,
		nativePayment: true,
	};

	const cancelTimeout = 60;
	const maxProfit300 = ethers.parseEther('300');
	const maxProfit1000 = ethers.parseEther('1000');

	async function deployAndInit(name, initFn) {
		if (getTargetAddress(name, network)) {
			console.log(`\n${name} already in deployments.json, skipping`);
			return await ethers.getContractAt(name, getTargetAddress(name, network));
		}
		const Factory = await ethers.getContractFactory(name);
		const proxy = await upgrades.deployProxy(Factory, [], { initializer: false });
		await proxy.waitForDeployment();
		const addr = await proxy.getAddress();
		console.log(`\n${name} deployed: ${addr}`);
		setTargetAddress(name, network, addr);
		await delay(5000);

		await initFn(proxy);
		console.log(`${name} initialized`);
		await delay(3000);

		const impl = await getImplementationAddress(ethers.provider, addr);
		setTargetAddress(`${name}Implementation`, network, impl);
		const proxyAdmin = await getAdminAddress(ethers.provider, addr);
		setTargetAddress(`${name}ProxyAdmin`, network, proxyAdmin);
		console.log(`${name} impl: ${impl}`);
		console.log(`${name} proxy admin: ${proxyAdmin}`);

		try {
			await hre.run('verify:verify', { address: impl });
		} catch (e) {
			console.log(`${name} verify:`, (e.message || e).slice(0, 120));
		}
		await delay(3000);
		return proxy;
	}

	// ==================== DICE ====================
	await deployAndInit('Dice', async (dice) => {
		await dice.initialize(
			coreAddresses,
			collateralConfig,
			maxProfit1000,
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
			maxProfit300,
			cancelTimeout,
			vrfConfig
		);
	});

	// ==================== BLACKJACK ====================
	await deployAndInit('Blackjack', async (bj) => {
		await bj.initialize(coreAddresses, collateralConfig, maxProfit300, cancelTimeout, vrfConfig);
	});

	// ==================== BACCARAT ====================
	await deployAndInit('Baccarat', async (bac) => {
		await bac.initialize(
			coreAddresses,
			collateralConfig,
			maxProfit300,
			cancelTimeout,
			0,
			vrfConfig
		);
	});

	// ==================== SLOTS ====================
	const slots = await deployAndInit('Slots', async (s) => {
		await s.initialize(
			coreAddresses,
			collateralConfig,
			maxProfit300,
			cancelTimeout,
			ethers.parseEther('0.02'), // houseEdge 2%
			ethers.parseEther('50'), // maxPayoutMultiplier 50x
			vrfConfig
		);
	});

	// Slots post-deploy config (idempotent-safe via try/catch on already-set values)
	await delay(3000);
	try {
		await slots.setSymbols(5, [34, 26, 18, 13, 9]);
		console.log('Slots symbols configured');
	} catch (e) {
		console.log('Slots setSymbols:', (e.message || e).slice(0, 120));
	}
	await delay(3000);

	const pairPayouts = [
		ethers.parseEther('0.5'),
		ethers.parseEther('0.75'),
		ethers.parseEther('1'),
		ethers.parseEther('1.25'),
		ethers.parseEther('1.75'),
	];
	for (let i = 0; i < pairPayouts.length; i++) {
		try {
			await slots.setPairPayout(i, pairPayouts[i]);
			console.log(`Slots pair payout[${i}] = ${ethers.formatEther(pairPayouts[i])}x`);
		} catch (e) {
			console.log(`Slots setPairPayout[${i}]:`, (e.message || e).slice(0, 120));
		}
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
		try {
			await slots.setTriplePayout(i, triplePayouts[i]);
			console.log(`Slots triple payout[${i}] = ${ethers.formatEther(triplePayouts[i])}x`);
		} catch (e) {
			console.log(`Slots setTriplePayout[${i}]:`, (e.message || e).slice(0, 120));
		}
		await delay(3000);
	}

	// ==================== ADMIN/OWNER SANITY ====================
	console.log('\n=== Proxy admin / owner ===');
	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const g of games) {
		const a = getTargetAddress(g, network);
		if (!a) continue;
		const c = await ethers.getContractAt(g, a);
		const pa = await getAdminAddress(ethers.provider, a);
		let paOwner = '(not a ProxyAdmin / UUPS)';
		try {
			const admin = new ethers.Contract(
				pa,
				['function owner() view returns (address)'],
				ethers.provider
			);
			paOwner = await admin.owner();
		} catch {}
		const gameOwner = await c.owner();
		console.log(`${g.padEnd(10)} gameOwner=${gameOwner}  proxyAdmin=${pa}  paOwner=${paOwner}`);
	}

	console.log(
		'\n=== Done. Consumers to add on vrf.chain.link (subscription id in deployments.json) ==='
	);
	for (const g of games) {
		const a = getTargetAddress(g, network);
		if (a) console.log(`  ${g}: ${a}`);
	}
	console.log('\nBankroll: transfer USDC/WETH/OVER to each game contract before opening bets.');
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
