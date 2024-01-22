const { ethers } = require('hardhat');

const { setTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const mockReferrals = await ethers.getContractFactory('MockReferrals');

	const mockReferralsDeployed = await mockReferrals.deploy();
	await mockReferralsDeployed.waitForDeployment();

	const mockReferralsAddress = await mockReferralsDeployed.getAddress();

	console.log('MockReferrals deployed on:', mockReferralsAddress);
	setTargetAddress('MockReferrals', network, mockReferralsAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: mockReferralsAddress,
			contract: 'contracts/utils/test-helpers/MockReferrals.sol:MockReferrals',
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
