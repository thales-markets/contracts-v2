const marketsTree = require(
	`../../scripts/deployOvertime/updateMerkleTree/treeMarketsAndHashes.json`
);

const INVALID_SPORT_ID = 8999;
const SPORT_ID_NBA = 9004;
const SPORT_ID_EPL = 9011;

const INVALID_CHILD_ID = 9999;
const CHILD_ID_SPREAD = 10001;
const CHILD_ID_TOTAL = 10002;
const CHILD_ID_PLAYER_PROPS = 10010;

const GAME_ID_1 = '0x3063613139613935343563616437636230393634613865623435363366336666'; // Milwaukee Bucks vs Indiana Pacers
const GAME_ID_2 = '0x3432313635323400000000000000000000000000000000000000000000000000'; // Milwaukee Bucks vs Indiana Pacers
const PLAYER_PROPS_ID_POINTS = 11029; // points
const PLAYER_ID_1 = 16429; // Giannis Antetokounmpo
const PLAYER_PROPS_LINE_1 = 3350; // 33.5 points
const TOTAL_LINE = 25600; // 256 points

const GAMES = {
	nbaMoneyline: marketsTree[0],
	nbaSpread: marketsTree[0].childMarkets[0],
	nbaSpreadNotActive: marketsTree[0].childMarkets[1],
	nbaTotal: marketsTree[0].childMarkets[2],
	nbaPlayerPropsPoints: marketsTree[0].childMarkets[3],
	nbaPlayerPropsDoubleDouble: marketsTree[0].childMarkets[4],
};

const BUY_IN_AMOUNT = ethers.parseEther('10');
const ADDITIONAL_SLIPPAGE = ethers.parseEther('0.02');

const DEFAULT_AMOUNT = ethers.parseEther('10000');

module.exports = {
	INVALID_SPORT_ID,
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	INVALID_CHILD_ID,
	CHILD_ID_SPREAD,
	CHILD_ID_TOTAL,
	CHILD_ID_PLAYER_PROPS,
	GAME_ID_1,
	GAME_ID_2,
	PLAYER_PROPS_ID_POINTS,
	PLAYER_ID_1,
	PLAYER_PROPS_LINE_1,
	GAMES,
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	DEFAULT_AMOUNT,
	TOTAL_LINE,
};
