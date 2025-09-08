const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);
	console.log('=====================================\n');

	// Get the SportsAMMV2ResultManager contract address
	const sportsAMMV2ResultManager = getTargetAddress('SportsAMMV2ResultManager', network);
	console.log('SportsAMMV2ResultManager address:', sportsAMMV2ResultManager);
	console.log('=====================================\n');

	// Attach to the deployed contract
	const SportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManagerDeployed = SportsAMMV2ResultManager.attach(sportsAMMV2ResultManager);

	// Load type mappings from JSON
	const types = require('./typesMappings.json');
	
	console.log(`Checking ${types.length} result type mappings...\n`);
	console.log('=====================================');

	let matches = 0;
	let mismatches = [];
	let errors = [];

	// Check each type
	for (let i = 0; i < types.length; i++) {
		let type = types[i];
		
		try {
			// Query the contract for the current result type
			const typeOnChain = await sportsAMMV2ResultManagerDeployed.resultTypePerMarketType(type.id);
			
			// Compare with expected value
			if (Number(typeOnChain) === type.result_type) {
				matches++;
				console.log(`[✓] Type ${type.id} (${type.name}): MATCH - Result type: ${type.result_type}`);
			} else {
				mismatches.push({
					id: type.id,
					name: type.name,
					expected: type.result_type,
					actual: Number(typeOnChain)
				});
				console.log(`[✗] Type ${type.id} (${type.name}): MISMATCH - Expected: ${type.result_type}, Actual: ${typeOnChain}`);
			}
		} catch (error) {
			errors.push({
				id: type.id,
				name: type.name,
				error: error.message
			});
			console.log(`[!] Type ${type.id} (${type.name}): ERROR - ${error.message}`);
		}
	}

	// Print summary
	console.log('\n=====================================');
	console.log('SUMMARY');
	console.log('=====================================');
	console.log(`Total types checked: ${types.length}`);
	console.log(`[✓] Matches: ${matches} (${((matches / types.length) * 100).toFixed(1)}%)`);
	console.log(`[✗] Mismatches: ${mismatches.length} (${((mismatches.length / types.length) * 100).toFixed(1)}%)`);
	console.log(`[!] Errors: ${errors.length} (${((errors.length / types.length) * 100).toFixed(1)}%)`);

	// Detailed mismatch report
	if (mismatches.length > 0) {
		console.log('\n=====================================');
		console.log('DETAILED MISMATCH REPORT');
		console.log('=====================================');
		console.log('The following types need to be updated:\n');
		
		mismatches.forEach(mismatch => {
			console.log(`ID: ${mismatch.id}`);
			console.log(`Name: ${mismatch.name}`);
			console.log(`Expected Result Type: ${mismatch.expected}`);
			console.log(`Actual Result Type: ${mismatch.actual}`);
			console.log('---');
		});
		
		console.log('\nTo fix these mismatches, run:');
		console.log(`npx hardhat run scripts/deployContracts/resultTypes/setResultTypes.js --network ${network}`);
	}

	// Error report
	if (errors.length > 0) {
		console.log('\n=====================================');
		console.log('ERROR REPORT');
		console.log('=====================================');
		errors.forEach(err => {
			console.log(`Type ${err.id} (${err.name}): ${err.error}`);
		});
	}

	// Final status
	console.log('\n=====================================');
	if (mismatches.length === 0 && errors.length === 0) {
		console.log('[✓] All result types are correctly configured!');
	} else {
		console.log(`[!] Found ${mismatches.length} mismatches and ${errors.length} errors that need attention.`);
		process.exit(1); // Exit with error code if there are issues
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error('Script failed:', error);
		process.exit(1);
	});