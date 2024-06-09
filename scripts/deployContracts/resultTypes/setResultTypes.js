const { ethers, upgrades } = require('hardhat');
const { getImplementationAddress, getAdminAddress } = require('@openzeppelin/upgrades-core');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2ResultManager = getTargetAddress('SportsAMMV2ResultManager', network);

	const SportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManagerDeployed =
		SportsAMMV2ResultManager.attach(sportsAMMV2ResultManager);

	const types = require(`./typesMappings`);

	for (let i = 0; i < types.length; i++) {
		let type = types[i];
		console.log(
			'processing type:' + type.id + ' ' + type.name + ' with result type:' + type.result_type
		);

		await sportsAMMV2ResultManagerDeployed.setResultTypesPerMarketTypes(
			[type.id],
			[type.result_type],
			{
				from: owner.address,
			}
		);
		console.log('type set');
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
