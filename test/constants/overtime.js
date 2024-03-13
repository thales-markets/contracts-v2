const marketsTree = require(
	`../../scripts/deployOvertime/updateMerkleTree/treeMarketsAndHashes.json`
);

const INVALID_SPORT_ID = 8999;
const SPORT_ID_NBA = 9004;
const SPORT_ID_EPL = 9011;

const INVALID_TYPE_ID = 9999;
const TYPE_ID_SPREAD = 10001;
const TYPE_ID_TOTAL = 10002;
const TYPE_ID_POINTS = 10010; // points

const GAME_ID_1 = '0x3063613139613935343563616437636230393634613865623435363366336666'; // Milwaukee Bucks vs Indiana Pacers
const GAME_ID_2 = '0x3432313635323400000000000000000000000000000000000000000000000000'; // Milwaukee Bucks vs Indiana Pacers
const PLAYER_ID_1 = 16429; // Giannis Antetokounmpo
const PLAYER_PROPS_LINE_1 = 3350; // 33.5 points
const TOTAL_LINE = 25600; // 256 points

const BUY_IN_AMOUNT = ethers.parseEther('10');
const ADDITIONAL_SLIPPAGE = ethers.parseEther('0.02');

const DEFAULT_AMOUNT = ethers.parseEther('10000');

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
	PLAYER_ID_1,
	PLAYER_PROPS_LINE_1,
	BUY_IN_AMOUNT,
	ADDITIONAL_SLIPPAGE,
	DEFAULT_AMOUNT,
	TOTAL_LINE,
};
