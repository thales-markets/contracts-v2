const { ethers } = require('hardhat');
const { setTargetAddress, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	// Deploy OverToken
	const OverToken = await ethers.getContractFactory('OverToken');
	const treasuryAddress = owner.address;

	const overTokenDeployed = await OverToken.deploy(owner.address);
	await overTokenDeployed.waitForDeployment();

	const overTokenAddress = await overTokenDeployed.getAddress();

	console.log('OverToken deployed on:', overTokenAddress);
	setTargetAddress('OverToken', network, overTokenAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: overTokenAddress,
			constructorArguments: [treasuryAddress],
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
