const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	const [owner] = await ethers.getSigners();
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;

	console.log('Owner:', owner.address);
	console.log('Network:', network);

	const proxyAddress = getTargetAddress('Baccarat', network);
	const factory = await ethers.getContractFactory('Baccarat');

	const implBefore = await getImplementationAddress(ethers.provider, proxyAddress);
	console.log('Impl before:', implBefore);

	await upgrades.upgradeProxy(proxyAddress, factory);

	const implAfter = await getImplementationAddress(ethers.provider, proxyAddress);
	console.log('Impl after: ', implAfter);

	setTargetAddress('BaccaratImplementation', network, implAfter);
	await delay(5000);

	try {
		await hre.run('verify:verify', { address: implAfter });
	} catch (e) {
		console.log('Verify:', e.message?.slice(0, 120) || e);
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
