const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	// 1. Deploy CasinoFreeBetsHolder
	const HolderFactory = await ethers.getContractFactory('CasinoFreeBetsHolder');
	const holder = await upgrades.deployProxy(HolderFactory, [], {
		initializer: false,
		initialOwner: getTargetAddress('ProtocolDAO', network),
	});
	await holder.waitForDeployment();
	const holderAddress = await holder.getAddress();
	console.log('CasinoFreeBetsHolder deployed:', holderAddress);
	setTargetAddress('CasinoFreeBetsHolder', network, holderAddress);
	await delay(5000);

	await holder.initialize(owner.address, 86400 * 30); // 30 day expiration
	console.log('CasinoFreeBetsHolder initialized');
	await delay(5000);

	const holderImpl = await getImplementationAddress(ethers.provider, holderAddress);
	setTargetAddress('CasinoFreeBetsHolderImplementation', network, holderImpl);

	try {
		await hre.run('verify:verify', { address: holderImpl });
	} catch (e) {
		console.log('Holder verify:', e.message?.slice(0, 80) || e);
	}
	await delay(3000);

	// 2. Upgrade all 5 casino contracts
	const GAMES = [
		{ name: 'Dice', implKey: 'DiceImplementation' },
		{ name: 'Roulette', implKey: 'RouletteImplementation' },
		{ name: 'Blackjack', implKey: 'BlackjackImplementation' },
		{ name: 'Baccarat', implKey: 'BaccaratImplementation' },
		{ name: 'Slots', implKey: 'SlotsImplementation' },
	];

	for (const game of GAMES) {
		const factory = await ethers.getContractFactory(game.name);
		const proxyAddress = getTargetAddress(game.name, network);

		if (isTestNetwork(networkObj.chainId)) {
			await upgrades.upgradeProxy(proxyAddress, factory);
		}

		const implAddress = await getImplementationAddress(ethers.provider, proxyAddress);
		console.log(`${game.name} upgraded. Impl: ${implAddress}`);
		setTargetAddress(game.implKey, network, implAddress);
		await delay(5000);

		// Set freeBetsHolder on each contract
		const contract = await ethers.getContractAt(game.name, proxyAddress);
		await contract.setFreeBetsHolder(holderAddress);
		console.log(`${game.name}: freeBetsHolder set`);
		await delay(3000);

		// Whitelist casino in holder
		await holder.setWhitelistedCasino(proxyAddress, true);
		console.log(`${game.name}: whitelisted in holder`);
		await delay(3000);

		try {
			await hre.run('verify:verify', { address: implAddress });
		} catch (e) {
			console.log(`${game.name} verify:`, e.message?.slice(0, 80) || e);
		}
		await delay(3000);
	}

	console.log('\n=== All done ===');
	console.log('CasinoFreeBetsHolder:', holderAddress);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
