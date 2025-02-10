const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	// Deploy SafeBox with the owner's address as the initial owner
	const SafeBox = await ethers.getContractFactory('SafeBox');
	const safeBoxDeployed = await upgrades.deployProxy(SafeBox, [owner.address], {});
	await safeBoxDeployed.waitForDeployment();

	const safeBoxAddress = await safeBoxDeployed.getAddress();

	console.log('SafeBox deployed on:', safeBoxAddress);
	setTargetAddress('SafeBox', network, safeBoxAddress);
	await delay(5000);

	// Get and set implementation address
	const implementationAddress = await getImplementationAddress(ethers.provider, safeBoxAddress);
	console.log('SafeBox Implementation:', implementationAddress);
	setTargetAddress('SafeBoxImplementation', network, implementationAddress);

	// Get and set proxy admin address
	const proxyAdminAddress = await getAdminAddress(ethers.provider, safeBoxAddress);
	console.log('SafeBox Proxy Admin:', proxyAdminAddress);
	setTargetAddress('SafeBoxProxyAdmin', network, proxyAdminAddress);

	await delay(5000);

	// Verify contract on Etherscan
	try {
		await hre.run('verify:verify', {
			address: safeBoxAddress,
		});
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
