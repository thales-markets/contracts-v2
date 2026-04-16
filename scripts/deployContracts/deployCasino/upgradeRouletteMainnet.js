const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);
	console.log('Chain ID:', networkObj.chainId.toString());

	// --- Roulette: full upgradeProxy (EOA is proxy owner) ---
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

	// Sanity check: call new method
	const roulette = await ethers.getContractAt('Roulette', rouletteAddress);
	const maxPicks = await roulette.MAX_PICKS_PER_BET();
	console.log('MAX_PICKS_PER_BET:', maxPicks.toString());

	try {
		await hre.run('verify:verify', { address: rouletteImpl });
	} catch (e) {
		console.log('Roulette verify:', e.message || e);
	}

	// --- FreeBetsHolder: prepareUpgrade only ---
	const holderFactory = await ethers.getContractFactory('FreeBetsHolder');
	const holderAddress = getTargetAddress('FreeBetsHolder', network);
	console.log('\n--- FreeBetsHolder (prepareUpgrade only) ---');
	console.log('Proxy:', holderAddress);

	const holderImpl = await upgrades.prepareUpgrade(holderAddress, holderFactory);
	console.log('New implementation deployed:', holderImpl);
	setTargetAddress('FreeBetsHolderImplementation', network, holderImpl);

	try {
		await hre.run('verify:verify', { address: holderImpl });
	} catch (e) {
		console.log('FreeBetsHolder verify:', e.message || e);
	}

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
