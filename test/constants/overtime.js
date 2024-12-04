const marketsTree = require(
	`../../scripts/deployContracts/updateMerkleTree/treeMarketsAndHashes.json`
);

const INVALID_SPORT_ID = 8999;
const SPORT_ID_NBA = 9004;
const SPORT_ID_EPL = 9011;
const SPORT_ID_SPAIN = 9014;

const INVALID_TYPE_ID = 9999;
const TYPE_ID_SPREAD = 10001;
const TYPE_ID_TOTAL = 10002;
const TYPE_ID_DOUBLE_CHANCE = 10003;
const TYPE_ID_WINNER_TOTAL = 10004;
const TYPE_ID_POINTS = 10010; // points

const GAME_ID_1 = '0x3063613139613935343563616437636230393634613865623435363366336666'; // Milwaukee Bucks vs Indiana Pacers
const GAME_ID_2 = '0x3432313635323400000000000000000000000000000000000000000000000000'; // Milwaukee Bucks vs Indiana Pacers
const GAME_ID_3 = '0x3830666564353637613166343639393836306561313639616432633330313538'; // REAL SOCIEDAD vs CADIZ
const GAME_ID_4 = '0x6638323130373532656136316335383961623334636430643565333833613936'; // MALLORCA vs GRANADA
const PLAYER_ID_1 = 16429; // Giannis Antetokounmpo
const PLAYER_PROPS_LINE_1 = 3350; // 33.5 points
const SPREAD_LINE = -100; // -1
const OVER_SPREAD_LINE = -200; // -2
const UNDER_SPREAD_LINE = 0; // 0
const TOTAL_LINE = 25600; // 256 points
const OVER_TOTAL_LINE = 26000; // 260 points
const UNDER_TOTAL_LINE = 24000; // 240 points
const WINNER_TOTAL_COMBINED_POSTIONS = [
	[
		{ typeId: 0, position: 0, line: 0 },
		{ typeId: TYPE_ID_TOTAL, position: 0, line: TOTAL_LINE },
	],
	[
		{ typeId: 0, position: 0, line: 0 },
		{ typeId: TYPE_ID_TOTAL, position: 1, line: TOTAL_LINE },
	],
	[
		{ typeId: 0, position: 1, line: 0 },
		{ typeId: TYPE_ID_TOTAL, position: 0, line: TOTAL_LINE },
	],
	[
		{ typeId: 0, position: 1, line: 0 },
		{ typeId: TYPE_ID_TOTAL, position: 1, line: TOTAL_LINE },
	],
];

const BUY_IN_AMOUNT = ethers.parseEther('10');
const BUY_IN_AMOUNT_SIX_DECIMALS = Number(10000000);
const ETH_BUY_IN_AMOUNT = ethers.parseEther('0.0028571428571429');
const ADDITIONAL_SLIPPAGE = ethers.parseEther('0.02');
const BONUS_PAYOUT = ethers.parseEther('0.03');
const BONUS_PAYOUT_OUT_OF_RANGE = ethers.parseEther('0.04');

const DEFAULT_AMOUNT = ethers.parseEther('10000');
const DEFAULT_AMOUNT_SIX_DECIMALS = Number('10000000000');
const ETH_DEFAULT_AMOUNT = ethers.parseEther('5');

const RESULT_TYPE = {
	Unassigned: 0,
	ExactPosition: 1,
	OverUnder: 2,
	CombinedPositions: 3,
	Spread: 4,
};

const MARKET_POSITION_STATUS = {
	Open: 0,
	Cancelled: 1,
	Winning: 2,
	Losing: 3,
};

const RISK_STATUS = {
	NoRisk: 0,
	OutOfLiquidity: 1,
	InvalidCombination: 2,
};

module.exports = {
	INVALID_SPORT_ID,
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	INVALID_TYPE_ID,
	TYPE_ID_SPREAD,
	TYPE_ID_TOTAL,
	TYPE_ID_POINTS,
	GAME_ID_1,
	GAME_ID_2,
	GAME_ID_3,
	GAME_ID_4,
	PLAYER_ID_1,
	PLAYER_PROPS_LINE_1,
	BUY_IN_AMOUNT,
	BUY_IN_AMOUNT_SIX_DECIMALS,
	ETH_BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	BONUS_PAYOUT,
	BONUS_PAYOUT_OUT_OF_RANGE,
	DEFAULT_AMOUNT,
	DEFAULT_AMOUNT_SIX_DECIMALS,
	ETH_DEFAULT_AMOUNT,
	TOTAL_LINE,
	TYPE_ID_DOUBLE_CHANCE,
	TYPE_ID_WINNER_TOTAL,
	RESULT_TYPE,
	WINNER_TOTAL_COMBINED_POSTIONS,
	MARKET_POSITION_STATUS,
	OVER_TOTAL_LINE,
	UNDER_TOTAL_LINE,
	SPREAD_LINE,
	OVER_SPREAD_LINE,
	UNDER_SPREAD_LINE,
	RISK_STATUS,
	SPORT_ID_SPAIN,
};
