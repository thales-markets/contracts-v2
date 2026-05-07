/**
 * One-shot deployer for the entire V2 casino stack.
 * Order: CasinoCoreV2 → ThreeCardPoker → OvertimeHoldem → Plinko → Crash → Mines → HiLo → CasinoDataV2
 *
 * Skips any contract whose address is already in deployments.json (so re-runs are idempotent
 * for partial failures). To force redeploy of a contract, manually clear its key first
 *
 * Usage:
 *   npx hardhat run scripts/deployContracts/deployCasinoV2/deployCasinoV2All.js \
 *     --network optimisticSepolia
 */

const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');
const { deployV2Game } = require('./_deployV2Game');

async function deployCore(network, owner) {
	const existing = getTargetAddress('CasinoCoreV2', network);
	if (existing) {
		console.log('CasinoCoreV2 already at:', existing, '— skipping deploy');
		return existing;
	}

	const protocolDAOAddress = getTargetAddress('ProtocolDAO', network);
	const sportsAMMV2ManagerAddress = getTargetAddress('SportsAMMV2Manager', network);
	const priceFeedAddress = getTargetAddress('PriceFeed', network);
	const vrfCoordinatorAddress = getTargetAddress('VRFCoordinator', network);
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);
	const referralsAddress = getTargetAddress('Referrals', network) || ethers.ZeroAddress;

	const usdcAddress = getTargetAddress('DefaultCollateral', network);
	const wethAddress = getTargetAddress('WETH', network);
	const overAddress = getTargetAddress('OVER', network);

	const Core = await ethers.getContractFactory('CasinoCoreV2');
	const deployed = await upgrades.deployProxy(Core, [], {
		initializer: false,
		initialOwner: protocolDAOAddress,
	});
	await deployed.waitForDeployment();
	const addr = await deployed.getAddress();
	console.log('CasinoCoreV2 deployed at:', addr);
	setTargetAddress('CasinoCoreV2', network, addr);
	await delay(5000);

	await deployed.initialize(
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
			wethPriceFeedKey: ethers.encodeBytes32String('WETH'),
			overPriceFeedKey: ethers.encodeBytes32String('OVER'),
		},
		ethers.parseEther('5000'),
		60,
		{
			subscriptionId: BigInt(getTargetAddress('VRFSubscriptionId', network)),
			keyHash: getTargetAddress('VRFKeyHash', network),
			callbackGasLimit: 1_000_000,
			requestConfirmations: 1,
			nativePayment: true, // V1 + V2 casino convention — pay VRF in native ETH
		}
	);
	console.log('CasinoCoreV2 initialized');
	await delay(5000);

	setTargetAddress(
		'CasinoCoreV2Implementation',
		network,
		await getImplementationAddress(ethers.provider, addr)
	);
	setTargetAddress('CasinoCoreV2ProxyAdmin', network, await getAdminAddress(ethers.provider, addr));

	try {
		await hre.run('verify:verify', { address: addr });
	} catch (e) {
		console.log('Verify (core):', e.message);
	}
	return addr;
}

async function deployGameIfMissing(factoryName, key) {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const existing = getTargetAddress(key, network);
	if (existing) {
		console.log(`${factoryName} already at: ${existing} — skipping`);
		return existing;
	}
	return await deployV2Game(factoryName, key);
}

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner:  ', owner.address);
	console.log('Network:', network);

	console.log('\n--- 1. CasinoCoreV2 ---');
	await deployCore(network, owner);

	console.log('\n--- 2. ThreeCardPoker ---');
	await deployGameIfMissing('ThreeCardPoker', 'ThreeCardPoker');

	console.log('\n--- 3. OvertimeHoldem ---');
	await deployGameIfMissing('OvertimeHoldem', 'OvertimeHoldem');

	console.log('\n--- 4. Plinko ---');
	await deployGameIfMissing('Plinko', 'Plinko');

	console.log('\n--- 5. Crash ---');
	await deployGameIfMissing('Crash', 'Crash');

	console.log('\n--- 6. Mines ---');
	await deployGameIfMissing('Mines', 'Mines');

	console.log('\n--- 7. HiLo ---');
	await deployGameIfMissing('HiLo', 'HiLo');

	console.log('\n--- 8. CasinoDataV2 ---');
	const existingData = getTargetAddress('CasinoDataV2', network);
	if (existingData) {
		console.log('CasinoDataV2 already at:', existingData);
	} else {
		const Data = await ethers.getContractFactory('CasinoDataV2');
		const deployed = await upgrades.deployProxy(Data, [], {
			initializer: false,
			initialOwner: owner.address,
		});
		await deployed.waitForDeployment();
		const addr = await deployed.getAddress();
		console.log('CasinoDataV2 deployed at:', addr);
		setTargetAddress('CasinoDataV2', network, addr);
		await delay(5000);

		await deployed.initialize(
			owner.address,
			getTargetAddress('CasinoCoreV2', network),
			getTargetAddress('ThreeCardPoker', network)
		);
		await delay(5000);

		const wireMap = {
			OvertimeHoldem: 'setOvertimeHoldem',
			Plinko: 'setPlinko',
			Crash: 'setCrash',
			Mines: 'setMines',
			HiLo: 'setHiLo',
		};
		for (const [key, setter] of Object.entries(wireMap)) {
			const gameAddr = getTargetAddress(key, network);
			if (gameAddr) {
				const tx = await deployed[setter](gameAddr);
				await tx.wait();
				console.log(`Wired ${key}`);
				await delay(2000);
			}
		}

		setTargetAddress(
			'CasinoDataV2Implementation',
			network,
			await getImplementationAddress(ethers.provider, addr)
		);
		setTargetAddress(
			'CasinoDataV2ProxyAdmin',
			network,
			await getAdminAddress(ethers.provider, addr)
		);
		try {
			await hre.run('verify:verify', { address: addr });
		} catch (e) {
			console.log('Verify (data):', e.message);
		}
	}

	console.log('\n==== ALL V2 CONTRACTS DEPLOYED ====');
	console.log('CasinoCoreV2 :', getTargetAddress('CasinoCoreV2', network));
	console.log('TCP          :', getTargetAddress('ThreeCardPoker', network));
	console.log("Hold'em      :", getTargetAddress('OvertimeHoldem', network));
	console.log('Plinko       :', getTargetAddress('Plinko', network));
	console.log('Crash        :', getTargetAddress('Crash', network));
	console.log('Mines        :', getTargetAddress('Mines', network));
	console.log('HiLo         :', getTargetAddress('HiLo', network));
	console.log('CasinoDataV2 :', getTargetAddress('CasinoDataV2', network));
	console.log('');
	console.log('==== POST-DEPLOY MANUAL STEPS ====');
	console.log('1. Add', getTargetAddress('CasinoCoreV2', network), 'as a Chainlink VRF consumer');
	console.log(
		'2. Whitelist CasinoCoreV2 on FreeBetsHolder',
		'(',
		getTargetAddress('FreeBetsHolder', network),
		')'
	);
	console.log('3. Fund CasinoCoreV2 with USDC bankroll for all 6 games');
	console.log('====================================');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
