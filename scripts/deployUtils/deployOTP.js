const { ethers } = require('hardhat');
const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const overtimePaymentToken = await ethers.getContractFactory('OvertimePaymentToken');

	const overtimePaymentTokenDeployed = await overtimePaymentToken.deploy();
	await overtimePaymentTokenDeployed.waitForDeployment();

	const overtimePaymentTokenAddress = await overtimePaymentTokenDeployed.getAddress();

	console.log('OvertimePaymentToken deployed on:', overtimePaymentTokenAddress);
	setTargetAddress('OvertimePaymentToken', network, overtimePaymentTokenAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: overtimePaymentTokenAddress,
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
