const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

const ZERO_ADDRESS = ethers.ZeroAddress;

async function main() {
	const accounts = await ethers.getSigners();
	const owner = accounts[0];
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	// Slots may not be wired on every chain — fall through to zero if missing
	const rouletteAddress = getTargetAddress('Roulette', network) || ZERO_ADDRESS;
	const blackjackAddress = getTargetAddress('Blackjack', network) || ZERO_ADDRESS;
	const diceAddress = getTargetAddress('Dice', network) || ZERO_ADDRESS;
	const baccaratAddress = getTargetAddress('Baccarat', network) || ZERO_ADDRESS;
	const slotsAddress = getTargetAddress('Slots', network) || ZERO_ADDRESS;

	console.log('Roulette:', rouletteAddress);
	console.log('Blackjack:', blackjackAddress);
	console.log('Dice:', diceAddress);
	console.log('Baccarat:', baccaratAddress);
	console.log('Slots:', slotsAddress);

	// CasinoData is read-only and frequently extended; keep ProxyAdmin owner on the deployer EOA
	// instead of the ProtocolDAO multisig so upgrades don't require a multisig roundtrip
	const CasinoData = await ethers.getContractFactory('CasinoData');
	const casinoDataDeployed = await upgrades.deployProxy(CasinoData, [], {
		initializer: false,
		initialOwner: owner.address,
	});
	await casinoDataDeployed.waitForDeployment();

	const casinoDataAddress = await casinoDataDeployed.getAddress();

	console.log('CasinoData deployed on:', casinoDataAddress);
	setTargetAddress('CasinoData', network, casinoDataAddress);

	await delay(5000);

	await casinoDataDeployed.initialize(
		owner.address,
		rouletteAddress,
		blackjackAddress,
		diceAddress,
		baccaratAddress,
		slotsAddress
	);
	console.log('CasinoData initialized');

	await delay(5000);

	const implementationAddress = await getImplementationAddress(ethers.provider, casinoDataAddress);
	console.log('CasinoData Implementation:', implementationAddress);
	setTargetAddress('CasinoDataImplementation', network, implementationAddress);

	const proxyAdminAddress = await getAdminAddress(ethers.provider, casinoDataAddress);
	console.log('CasinoData Proxy Admin:', proxyAdminAddress);
	setTargetAddress('CasinoDataProxyAdmin', network, proxyAdminAddress);

	await delay(5000);

	try {
		await hre.run('verify:verify', { address: casinoDataAddress });
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
