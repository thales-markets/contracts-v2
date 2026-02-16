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

	// Collect all missing types
	let missingTypes = [];
	let missingResultTypes = [];

	console.log('Checking which types need to be set...\n');

	for (let i = 0; i < types.length; i++) {
		let type = types[i];
		console.log(
			'processing type:' + type.id + ' ' + type.name + ' with result type:' + type.result_type
		);

		const typeSet = await sportsAMMV2ResultManagerDeployed.resultTypePerMarketType(type.id);

		console.log('result type on contract: ' + typeSet);

		if (typeSet != type.result_type) {
			missingTypes.push(type.id);
			missingResultTypes.push(type.result_type);
			console.log('type needs to be set');
		} else {
			console.log('type already set');
		}
	}

	// If there are missing types, set them all in one transaction
	if (missingTypes.length > 0) {
		console.log('\n=====================================');
		console.log(`Setting ${missingTypes.length} result types in a single transaction...`);
		console.log('=====================================\n');

		const tx = await sportsAMMV2ResultManagerDeployed.setResultTypesPerMarketTypes(
			missingTypes,
			missingResultTypes,
			{
				from: owner.address,
			}
		);

		console.log('Transaction sent:', tx.hash);
		console.log('Waiting for confirmation...');

		await tx.wait();

		console.log('Transaction confirmed!');
		console.log(`Successfully set ${missingTypes.length} result types.`);

		await delay(1000); // 1 second delay after transaction
	} else {
		console.log('\n=====================================');
		console.log('All types are already correctly set!');
		console.log('=====================================');
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
