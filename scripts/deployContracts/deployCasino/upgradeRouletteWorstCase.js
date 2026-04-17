const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);
	console.log('Chain ID:', networkObj.chainId.toString());

	const rouletteFactory = await ethers.getContractFactory('Roulette');
	const rouletteAddress = getTargetAddress('Roulette', network);
	console.log('\n--- Roulette ---');
	console.log('Proxy:', rouletteAddress);

	const implBefore = await getImplementationAddress(ethers.provider, rouletteAddress);
	console.log('Impl before:', implBefore);

	await upgrades.upgradeProxy(rouletteAddress, rouletteFactory);
	await delay(10000);

	const rouletteImpl = await getImplementationAddress(ethers.provider, rouletteAddress);
	console.log('Impl after:', rouletteImpl);
	setTargetAddress('RouletteImplementation', network, rouletteImpl);

	// Sanity: MAX_PICKS_PER_BET still 10 (layout preserved)
	const roulette = await ethers.getContractAt('Roulette', rouletteAddress);
	const maxPicks = await roulette.MAX_PICKS_PER_BET();
	console.log('MAX_PICKS_PER_BET:', maxPicks.toString());
	console.log('maxProfitUsd:', (await roulette.maxProfitUsd()).toString());

	try {
		await hre.run('verify:verify', { address: rouletteImpl });
	} catch (e) {
		console.log('Roulette verify:', e.message || e);
	}

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
