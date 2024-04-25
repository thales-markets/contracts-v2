const { ethers } = require('hardhat');
const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const thales = await ethers.getContractFactory('Thales');

	const thalesDeployed = await thales.deploy();
	await thalesDeployed.waitForDeployment();

	const thalesAddress = await thalesDeployed.getAddress();

	console.log('Thales deployed on:', thalesAddress);
	setTargetAddress('Thales', network, thalesAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: thalesAddress,
			contract: 'contracts/utils/test-helpers/Thales.sol:Thales',
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
