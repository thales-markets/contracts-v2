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

	const typeIds = [
		0, 10001, 10002, 10003, 10004, 10005, 10006, 10009, 10021, 10022, 10031, 10032, 10033, 10034,
		10035, 10101, 10102, 10041, 10042, 10013, 10014, 10017, 10018, 10111, 10112, 10211, 10212,
		11010, 11011, 11012, 11019, 11029, 11035, 11038, 11039, 11047, 11049, 11051, 11052, 11053,
		11055, 11056, 11057, 11058, 11060, 11086, 11087, 11088, 11097,
	];

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
		RESULT_TYPE.OverUnder, // 10033
		RESULT_TYPE.OverUnder, // 10034
		RESULT_TYPE.OverUnder, // 10035
		RESULT_TYPE.OverUnder, // 10101
		RESULT_TYPE.OverUnder, // 10102
		RESULT_TYPE.OverUnder, // 10041
		RESULT_TYPE.OverUnder, // 10042
		RESULT_TYPE.OverUnder, // 10013
		RESULT_TYPE.OverUnder, // 10014
		RESULT_TYPE.OverUnder, // 10017
		RESULT_TYPE.OverUnder, // 10018
		RESULT_TYPE.OverUnder, // 10111
		RESULT_TYPE.OverUnder, // 10112
		RESULT_TYPE.OverUnder, // 10211
		RESULT_TYPE.OverUnder, // 10212
		RESULT_TYPE.OverUnder, // 11010,
		RESULT_TYPE.OverUnder, // 11011,
		RESULT_TYPE.OverUnder, // 11012,
		RESULT_TYPE.OverUnder, // 11019,
		RESULT_TYPE.OverUnder, // 11029,
		RESULT_TYPE.OverUnder, // 11035,
		RESULT_TYPE.OverUnder, // 11038,
		RESULT_TYPE.OverUnder, // 11039,
		RESULT_TYPE.OverUnder, // 11047,
		RESULT_TYPE.OverUnder, // 11049,
		RESULT_TYPE.OverUnder, // 11051,
		RESULT_TYPE.OverUnder, // 11052,
		RESULT_TYPE.OverUnder, // 11053,
		RESULT_TYPE.OverUnder, // 11055,
		RESULT_TYPE.OverUnder, // 11056,
		RESULT_TYPE.OverUnder, // 11057,
		RESULT_TYPE.OverUnder, // 11058,
		RESULT_TYPE.OverUnder, // 11060,
		RESULT_TYPE.OverUnder, // 11086,
		RESULT_TYPE.OverUnder, // 11087,
		RESULT_TYPE.OverUnder, // 11088,
		RESULT_TYPE.OverUnder, // 11097
	];

	if (resultTypeIds.length == typeIds.length) {
		await sportsAMMV2ResultManagerDeployed.setResultTypesPerMarketTypes(typeIds, resultTypeIds);

		console.log('Results types set');
	} else {
		console.log('Results types lengths dont match');
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
