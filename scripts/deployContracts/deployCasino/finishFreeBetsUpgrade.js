const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	const holderAddress = getTargetAddress('CasinoFreeBetsHolder', network);
	const holder = await ethers.getContractAt('CasinoFreeBetsHolder', holderAddress);

	const GAMES = [
		{ name: 'Dice', implKey: 'DiceImplementation' },
		{ name: 'Roulette', implKey: 'RouletteImplementation' },
		{ name: 'Blackjack', implKey: 'BlackjackImplementation' },
		{ name: 'Baccarat', implKey: 'BaccaratImplementation' },
		{ name: 'Slots', implKey: 'SlotsImplementation' },
	];

	for (const game of GAMES) {
		const proxyAddress = getTargetAddress(game.name, network);
		const contract = await ethers.getContractAt(game.name, proxyAddress);

		// Check if already upgraded (has freeBetsHolder)
		let currentHolder;
		try {
			currentHolder = await contract.freeBetsHolder();
		} catch {
			currentHolder = null;
		}

		if (currentHolder === holderAddress) {
			console.log(`${game.name}: already configured, skipping`);
			continue;
		}

		// Upgrade
		const factory = await ethers.getContractFactory(game.name);
		if (isTestNetwork(networkObj.chainId)) {
			try {
				await upgrades.upgradeProxy(proxyAddress, factory);
				console.log(`${game.name}: upgraded`);
			} catch (e) {
				if (e.message.includes('already been upgraded')) {
					console.log(`${game.name}: already latest impl`);
				} else {
					throw e;
				}
			}
		}

		const implAddress = await getImplementationAddress(ethers.provider, proxyAddress);
		setTargetAddress(game.implKey, network, implAddress);
		await delay(5000);

		// Set holder
		try {
			await contract.setFreeBetsHolder(holderAddress);
			console.log(`${game.name}: freeBetsHolder set`);
			await delay(3000);
		} catch (e) {
			console.log(`${game.name}: setFreeBetsHolder failed:`, e.message?.slice(0, 60));
		}

		// Whitelist
		const isWhitelisted = await holder.whitelistedCasino(proxyAddress);
		if (!isWhitelisted) {
			await holder.setWhitelistedCasino(proxyAddress, true);
			console.log(`${game.name}: whitelisted`);
			await delay(3000);
		}

		// Verify
		try {
			await hre.run('verify:verify', { address: implAddress });
		} catch (e) {
			console.log(`${game.name} verify:`, e.message?.slice(0, 80) || e);
		}
		await delay(3000);
	}

	console.log('\nDone');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
