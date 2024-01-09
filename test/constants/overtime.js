const INVALID_SPORT_ID = 8999;
const SPORT_ID_NBA = 9004;
const SPORT_ID_EPL = 9011;

const INVALID_CHILD_ID = 9999;
const CHILD_ID_SPREAD = 10001;
const CHILD_ID_TOTAL = 10002;
const CHILD_ID_PLAYER_PROPS = 10010;

const GAME_ID_1 = '0x3063613139613935343563616437636230393634613865623435363366336666'; // Milwaukee Bucks vs Indiana Pacers
const PLAYER_PROPS_ID_POINTS = 11029; // points
const PLAYER_ID_1 = 16429; // Giannis Antetokounmpo
const PLAYER_PROPS_LINE_1 = 3350; // 33.5 points

const MANAGER_INITAL_PARAMS = {
	needsTransformingCollateral: false,
};

const RISK_MANAGER_INITAL_PARAMS = {
	defaultCap: ethers.parseEther('1000'),
	defaultRiskMultiplier: 3,
	maxCap: ethers.parseEther('20000'),
	maxRiskMultiplier: 5,
};

const RISK_MANAGER_PARAMS = {
	invalidCap: ethers.parseEther('30000'),
	newDefaultCap: ethers.parseEther('2000'),
	invalidMaxCap: ethers.parseEther('900'),
	newMaxCap: ethers.parseEther('10000'),
	newCapForSport: ethers.parseEther('10000'),
	newCapForSportAndChild: ethers.parseEther('900'),
	newCapForGame: ethers.parseEther('5000'),

	invalidRiskMultiplier: 6,
	newDefaultRiskMultiplier: 4,
	invalidMaxRiskMultiplier: 3,
	newMaxRiskMultiplier: 5,
	newRiskMultiplierForSport: 5,
	newRiskMultiplierForGame: 3,

	newDynamicLiquidityCutoffTime: 6 * 60 * 60, // 6 hours
	newDynamicLiquidityCutoffDivider: ethers.parseEther('4'),
};

const SPORTS_AMM_INITAL_PARAMS = {
	safeBoxFee: ethers.parseEther('0.02'),
	minBuyInAmount: ethers.parseEther('3'),
	maxTicketSize: 10,
	maxSupportedAmount: ethers.parseEther('20000'),
	maxSupportedOdds: ethers.parseEther('0.01'),

	minimalTimeLeftToMaturity: 10,
	expiryDuration: 7776000,
};

const ZERO_ADDRESS = '0x' + '0'.repeat(40);

const ONE_DAY_IN_SECS = 24 * 60 * 60;

module.exports = {
	INVALID_SPORT_ID,
	SPORT_ID_NBA,
	SPORT_ID_EPL,
	INVALID_CHILD_ID,
	CHILD_ID_SPREAD,
	CHILD_ID_TOTAL,
	CHILD_ID_PLAYER_PROPS,
	GAME_ID_1,
	PLAYER_PROPS_ID_POINTS,
	PLAYER_ID_1,
	PLAYER_PROPS_LINE_1,
	RISK_MANAGER_INITAL_PARAMS,
	RISK_MANAGER_PARAMS,
	ZERO_ADDRESS,
	ONE_DAY_IN_SECS,
	SPORTS_AMM_INITAL_PARAMS,
	MANAGER_INITAL_PARAMS,
};
