const { ethers } = require('hardhat');

const { setTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockStakingThales = await ethers.getContractFactory('MockStakingThales');

	const mockStakingThalesDeployed = await mockStakingThales.deploy();
	await mockStakingThalesDeployed.waitForDeployment();

	const mockStakingThalesAddress = await mockStakingThalesDeployed.getAddress();

	console.log('MockStakingThales deployed on:', mockStakingThalesAddress);
	setTargetAddress('MockStakingThales', network, mockStakingThalesAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockStakingThalesAddress,
			contract: 'contracts/utils/test-helpers/MockStakingThales.sol:MockStakingThales',
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
