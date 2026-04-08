const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	const owner = (await ethers.getSigners())[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner:', owner.address);
	console.log('Network:', network);

	// 1. Upgrade FreeBetsHolder
	const holderAddress = getTargetAddress('FreeBetsHolder', network);
	if (!holderAddress) {
		console.log(
			'FreeBetsHolder not found in deployments. Looking for FreeBetsHolderImplementation...'
		);
		return;
	}
	console.log('FreeBetsHolder proxy:', holderAddress);

	const factory = await ethers.getContractFactory('FreeBetsHolder');
	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(holderAddress, factory);
	} else {
		const impl = await upgrades.prepareUpgrade(holderAddress, factory);
		console.log('Prepared implementation:', impl);
	}

	const implAddress = await getImplementationAddress(ethers.provider, holderAddress);
	console.log('FreeBetsHolder upgraded. Impl:', implAddress);
	setTargetAddress('FreeBetsHolderImplementation', network, implAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', { address: implAddress });
	} catch (e) {
		console.log('Verify:', e.message?.slice(0, 80) || e);
	}

	// 2. Configure casino whitelist on FreeBetsHolder
	const holder = await ethers.getContractAt('FreeBetsHolder', holderAddress);

	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const isWhitelisted = await holder.whitelistedCasino(addr);
		if (!isWhitelisted) {
			await holder.setWhitelistedCasino(addr, true);
			console.log(`${name} (${addr}): whitelisted in FreeBetsHolder`);
			await delay(3000);
		} else {
			console.log(`${name}: already whitelisted`);
		}
	}

	// 3. Point casino contracts to FreeBetsHolder (not CasinoFreeBetsHolder)
	for (const name of games) {
		const addr = getTargetAddress(name, network);
		const contract = await ethers.getContractAt(name, addr);
		const currentHolder = await contract.freeBetsHolder();
		if (currentHolder.toLowerCase() !== holderAddress.toLowerCase()) {
			await contract.setFreeBetsHolder(holderAddress);
			console.log(`${name}: freeBetsHolder updated to FreeBetsHolder`);
			await delay(3000);
		} else {
			console.log(`${name}: already points to FreeBetsHolder`);
		}
	}

	console.log('\nDone.');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
