const { ethers } = require('hardhat');
const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const exoticUSDT = await ethers.getContractFactory('ExoticUSDT');

	const exoticUSDTDeployed = await exoticUSDT.deploy();
	await exoticUSDTDeployed.waitForDeployment();

	const exoticUSDTAddress = await exoticUSDTDeployed.getAddress();

	console.log('ExoticUSDT deployed on:', exoticUSDTAddress);
	setTargetAddress('ExoticUSDT', network, exoticUSDTAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: exoticUSDTAddress,
			contract: 'contracts/utils/test-helpers/ExoticUSDT.sol:ExoticUSDT',
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
