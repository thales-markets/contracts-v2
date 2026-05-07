/**
 * Deploys CasinoCoreV2 — the singleton treasury / VRF dispatcher / circuit-breaker for the V2
 * casino games. Reads existing protocol addresses (manager, priceFeed, vrfCoordinator,
 * freeBetsHolder, etc.) from deployments.json
 *
 * Run AFTER existing protocol contracts are in place. Run BEFORE any V2 game contracts —
 * games register against this core during their own deploy scripts.
 *
 * Post-deploy steps NOT covered here (must be done manually or via wireCasinoV2.js):
 *   1. Add CasinoCoreV2 as a Chainlink VRF consumer on the configured subscription
 *   2. Whitelist CasinoCoreV2 on FreeBetsHolder (owner-only call on FBH)
 *   3. Fund CasinoCoreV2 with USDC bankroll (it holds liquidity for all V2 games)
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/deployCasinoCoreV2.js \
 *     --network optimisticSepolia
 */

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
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);
	const referralsAddress = getTargetAddress('Referrals', network) || ethers.ZeroAddress;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);
	// Match V1 casino convention on optimisticSepolia (V1 keys WETH→'WETH', OVER→'OVER').
	// The V1 _deploy_ scripts set 'ETH' but it was overridden post-deploy on testnet. Use the
	// on-chain values directly so V2 matches V1 consistently
	const wethPriceFeedKey = ethers.encodeBytes32String('WETH');
	const overPriceFeedKey = ethers.encodeBytes32String('OVER');

	const maxProfitUsd = ethers.parseEther('5000'); // per-bet cap
	const cancelTimeout = 60; // seconds

	const subscriptionId = BigInt(getTargetAddress('VRFSubscriptionId', network));
	const keyHash = getTargetAddress('VRFKeyHash', network);
	const callbackGasLimit = 1_000_000; // higher than per-game contracts since core dispatches
	const requestConfirmations = 1;
	const nativePayment = true; // V1 + V2 casino convention — pay VRF in native ETH (memory: project_casino_vrf_native_payment)

	console.log('Manager      :', sportsAMMV2ManagerAddress);
	console.log('PriceFeed    :', priceFeedAddress);
	console.log('VRFCoordinator:', vrfCoordinatorAddress);
	console.log('FreeBetsHolder:', freeBetsHolderAddress);
	console.log('Referrals    :', referralsAddress);
	console.log('USDC         :', usdcAddress);
	console.log('WETH         :', wethAddress);
	console.log('OVER         :', overAddress);

	const Core = await ethers.getContractFactory('CasinoCoreV2');
	const coreDeployed = await upgrades.deployProxy(Core, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await coreDeployed.waitForDeployment();

	const coreAddress = await coreDeployed.getAddress();
	console.log('CasinoCoreV2 deployed at:', coreAddress);
	setTargetAddress('CasinoCoreV2', network, coreAddress);

	await delay(5000);

	await coreDeployed.initialize(
		{
			owner: owner.address,
			manager: sportsAMMV2ManagerAddress,
			priceFeed: priceFeedAddress,
			vrfCoordinator: vrfCoordinatorAddress,
			freeBetsHolder: freeBetsHolderAddress,
			referrals: referralsAddress,
		},
		{
			usdc: usdcAddress,
			weth: wethAddress,
			over: overAddress,
			wethPriceFeedKey,
			overPriceFeedKey,
		},
		maxProfitUsd,
		cancelTimeout,
		{
			subscriptionId,
			keyHash,
			callbackGasLimit,
			requestConfirmations,
			nativePayment,
		}
	);
	console.log('CasinoCoreV2 initialized');

	await delay(5000);

	const implAddress = await getImplementationAddress(ethers.provider, coreAddress);
	console.log('CasinoCoreV2 Implementation:', implAddress);
	setTargetAddress('CasinoCoreV2Implementation', network, implAddress);

	const proxyAdminAddress = await getAdminAddress(ethers.provider, coreAddress);
	console.log('CasinoCoreV2 ProxyAdmin    :', proxyAdminAddress);
	setTargetAddress('CasinoCoreV2ProxyAdmin', network, proxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', { address: coreAddress });
	} catch (e) {
		console.log('Verification failed (likely already verified or rate-limited):', e.message);
	}

	console.log('');
	console.log('==== POST-DEPLOY MANUAL STEPS ====');
	console.log(
		'1. Add',
		coreAddress,
		'as a VRF consumer on subscription',
		subscriptionId.toString()
	);
	console.log('2. Whitelist', coreAddress, 'on FreeBetsHolder (', freeBetsHolderAddress, ')');
	console.log('3. Fund', coreAddress, 'with USDC bankroll for all 6 V2 games');
	console.log('====================================');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
