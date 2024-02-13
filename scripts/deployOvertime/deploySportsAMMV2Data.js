const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');

const { setTargetAddress, getTargetAddress } = require('../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);

	const sportsAMMV2Data = await ethers.getContractFactory('SportsAMMV2Data');
	const sportsAMMV2DataDeployed = await upgrades.deployProxy(sportsAMMV2Data, [
		owner.address,
		sportsAMMV2Address,
	]);
	await sportsAMMV2DataDeployed.waitForDeployment();

	const sportsAMMV2DataAddress = await sportsAMMV2DataDeployed.getAddress();

	console.log('SportsAMMV2Data deployed on:', sportsAMMV2DataAddress);
	setTargetAddress('SportsAMMV2Data', network, sportsAMMV2DataAddress);
	await delay(5000);

	const sportsAMMV2DataImplementationAddress = await getImplementationAddress(
		ethers.provider,
		sportsAMMV2DataAddress
	);

	console.log('SportsAMMV2Data Implementation:', sportsAMMV2DataImplementationAddress);
	setTargetAddress('SportsAMMV2DataImplementation', network, sportsAMMV2DataImplementationAddress);
	await delay(5000);

	try {
		await hre.run('verify:verify', {
			address: sportsAMMV2DataAddress,
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
