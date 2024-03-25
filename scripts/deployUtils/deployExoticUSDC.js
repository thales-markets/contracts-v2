const { ethers } = require('hardhat');
const { setTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const exoticUSDC = await ethers.getContractFactory('ExoticUSDC');

	const exoticUSDCDeployed = await exoticUSDC.deploy();
	await exoticUSDCDeployed.waitForDeployment();

	const exoticUSDCAddress = await exoticUSDCDeployed.getAddress();

	console.log('ExoticUSDC deployed on:', exoticUSDCAddress);
	setTargetAddress('ExoticUSDC', network, exoticUSDCAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: exoticUSDCAddress,
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

function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time);
	});
}
