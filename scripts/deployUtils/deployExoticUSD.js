const { ethers } = require('hardhat');
const { setTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const exoticUSD = await ethers.getContractFactory('ExoticUSD');

	const exoticUSDDeployed = await exoticUSD.deploy();
	await exoticUSDDeployed.waitForDeployment();

	const exoticUSDAddress = await exoticUSDDeployed.getAddress();

	console.log('ExoticUSD deployed on:', exoticUSDAddress);
	setTargetAddress('ExoticUSD', network, exoticUSDAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: exoticUSDAddress,
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
