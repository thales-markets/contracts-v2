const { ethers } = require('hardhat');
const { setTargetAddress, getTargetAddress, isTestNetwork, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2Utils = await ethers.getContractFactory('SportsAMMV2Utils');

	const sportsAMMV2UtilsDeployed = await sportsAMMV2Utils.deploy();
	await sportsAMMV2UtilsDeployed.waitForDeployment();

	const sportsAMMV2UtilsAddress = await sportsAMMV2UtilsDeployed.getAddress();

	console.log('SportsAMMV2Utils deployed on:', sportsAMMV2UtilsAddress);
	setTargetAddress('SportsAMMV2Utils', network, sportsAMMV2UtilsAddress);
	await delay(5000);

	if (isTestNetwork(networkObj.chainId)) {
		const sportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
		const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
		const sportsAMMV2Deployed = sportsAMMV2.attach(sportsAMMV2Address);
		await sportsAMMV2Deployed.setSportsAMMV2Utils(sportsAMMV2UtilsAddress, {
			from: owner.address,
		});
		console.log('SportsAMMV2Utils set in SportsAMMV2');
	}

	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2UtilsAddress,
			contract: 'contracts/core/AMM/SportsAMMV2Utils.sol:SportsAMMV2Utils',
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
