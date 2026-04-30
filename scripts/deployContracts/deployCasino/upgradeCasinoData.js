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

	const CasinoData = await ethers.getContractFactory('CasinoData');
	const casinoDataAddress = getTargetAddress('CasinoData', network);

	let implementationAddress;

	if (isTestNetwork(networkObj.chainId)) {
		await upgrades.upgradeProxy(casinoDataAddress, CasinoData);
		implementationAddress = await getImplementationAddress(ethers.provider, casinoDataAddress);
	} else {
		implementationAddress = await upgrades.prepareUpgrade(casinoDataAddress, CasinoData);
	}

	console.log('CasinoData upgraded');
	console.log('CasinoData Implementation:', implementationAddress);
	setTargetAddress('CasinoDataImplementation', network, implementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', { address: implementationAddress });
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
