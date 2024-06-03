const { ethers } = require('hardhat');
const { setTargetAddress, delay } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const SwapPaths = await ethers.getContractFactory('PackingSwapPaths');

	const SwapPathsDeployed = await SwapPaths.deploy();
	await SwapPathsDeployed.waitForDeployment();

	const SwapPathsAddress = await SwapPathsDeployed.getAddress();

	console.log('SwapPaths deployed on:', SwapPathsAddress);
	setTargetAddress('PackingSwapPaths', network, SwapPathsAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: SwapPathsAddress,
			contract: 'contracts/utils/test-helpers/PackingSwapPaths.sol:PackingSwapPaths',
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
