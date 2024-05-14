const { ethers, upgrades } = require('hardhat');
const { setTargetAddress, getTargetAddress, delay } = require('../../helpers');
const {
	TYPE_ID_TOTAL,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
} = require('../../../test/constants/overtime');

async function main() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const SportsAMMV2ResultManagerAddress = getTargetAddress('SportsAMMV2ResultManager', network);

	const sportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManagerDeployed = sportsAMMV2ResultManager.attach(
		SportsAMMV2ResultManagerAddress
	);

	const typeIds = [0, 10001, 10002, 10003, 10004, 10005, 10006, 10009, 10021, 10022, 10031, 10032];

	const resultTypeIds = [
		RESULT_TYPE.ExactPosition, // 0
		RESULT_TYPE.OverUnder, // 10001
		RESULT_TYPE.OverUnder, // 10002
		RESULT_TYPE.ExactPosition, // 10003
		RESULT_TYPE.CombinedPositions, // 10004
		RESULT_TYPE.ExactPosition, // 10005
		RESULT_TYPE.CombinedPositions, // 10006
		RESULT_TYPE.ExactPosition, // 10009
		RESULT_TYPE.ExactPosition, // 10021
		RESULT_TYPE.ExactPosition, // 10022
		RESULT_TYPE.OverUnder, // 10031
		RESULT_TYPE.OverUnder, // 10032
	];

	await sportsAMMV2ResultManagerDeployed.setResultTypesPerMarketTypes(typeIds, resultTypeIds);

	console.log('Results types set');
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
