const { ONE_WEEK_IN_SECS } = require('./general');

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

const SPORTS_AMM_LP_INITAL_PARAMS = {
	maxAllowedDeposit: ethers.parseEther('20000'),
	minDepositAmount: ethers.parseEther('20'),
	maxAllowedUsers: 100,
	roundLength: ONE_WEEK_IN_SECS,
	utilizationRate: ethers.parseEther('0.2'),
	safeBoxImpact: ethers.parseEther('0.2'),
};

module.exports = {
	MANAGER_INITAL_PARAMS,
	RISK_MANAGER_INITAL_PARAMS,
	RISK_MANAGER_PARAMS,
	SPORTS_AMM_INITAL_PARAMS,
	SPORTS_AMM_LP_INITAL_PARAMS,
};
