const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
	// Configuration
	const ARBITRUM_CHAIN_ID = '42161';
	const RESULT_MANAGER_ADDRESS = '0xE8eB19E45608B90Af2046a44A0d6a736FCc8D337';

	// Market type IDs and result types from user input
	const marketTypeIds = [
		10136, 10137, 10138, 10139, 10140, 10274, 10275, 10276, 10277, 10278,
		10279, 10280, 10281, 10282, 10283, 10284, 10285, 10286, 10287, 10288,
		10289, 10290, 10291, 10292, 10293
	];

	const resultTypes = [
		1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
		1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
		2, 2, 2, 2, 2
	];

	console.log('Generating Safe transaction for Arbitrum...');
	console.log(`Market Type IDs: ${marketTypeIds.length}`);
	console.log(`Result Types: ${resultTypes.length}`);

	// Get the contract ABI to encode the function call
	const SportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');

	// Encode the function call
	const iface = SportsAMMV2ResultManager.interface;
	const encodedData = iface.encodeFunctionData('setResultTypesPerMarketTypes', [
		marketTypeIds,
		resultTypes
	]);

	console.log('\nEncoded data:', encodedData);

	// Create the Safe transaction JSON
	const safeTransaction = {
		chainId: ARBITRUM_CHAIN_ID,
		transactions: [
			{
				to: RESULT_MANAGER_ADDRESS,
				value: '0',
				data: encodedData
			}
		]
	};

	// Write to file
	const outputPath = path.join(__dirname, 'arbitrum-safe-transaction.json');
	fs.writeFileSync(outputPath, JSON.stringify(safeTransaction, null, 2));

	console.log('\n=====================================');
	console.log('Safe transaction JSON generated successfully!');
	console.log(`Output file: ${outputPath}`);
	console.log('=====================================\n');

	console.log('Transaction Details:');
	console.log(`Chain ID: ${ARBITRUM_CHAIN_ID} (Arbitrum One)`);
	console.log(`Contract: ${RESULT_MANAGER_ADDRESS}`);
	console.log(`Function: setResultTypesPerMarketTypes`);
	console.log(`Market Types: ${marketTypeIds.length} types`);
	console.log(`Result Types: ${resultTypes.length} types`);

	// Display the JSON for verification
	console.log('\nGenerated JSON:');
	console.log(JSON.stringify(safeTransaction, null, 2));
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
