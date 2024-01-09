const { upgrades } = require('hardhat');
const {
	RISK_MANAGER_INITAL_PARAMS,
	SPORTS_AMM_INITAL_PARAMS,
	MANAGER_INITAL_PARAMS,
} = require('../../constants/overtime');

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.

async function deployAccountsFixture() {
	// Contracts are deployed using the first signer/account by default
	const [
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		fifthAccount,
		referrals,
		stakingThales,
		safeBox,
	] = await ethers.getSigners();

	return {
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		fifthAccount,
		referrals,
		stakingThales,
		safeBox,
	};
}

async function deployTokenFixture() {
	const ExoticUSD = await ethers.getContractFactory('ExoticUSD');
	const collateral = await ExoticUSD.deploy();

	const ExoticUSDC = await ethers.getContractFactory('ExoticUSDC');
	const collateralSixDecimals = await ExoticUSDC.deploy();

	return {
		collateral,
		collateralSixDecimals,
	};
}

// one fixture for all Sports AMM contracts, because nasted fixtures don't work for some reason
async function deploySportsAMMV2Fixture() {
	const { owner, referrals, stakingThales, safeBox } = await deployAccountsFixture();
	const { collateral } = await deployTokenFixture();

	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const sportsAMMV2Manager = await upgrades.deployProxy(SportsAMMV2Manager, [
		owner.address,
		MANAGER_INITAL_PARAMS.needsTransformingCollateral,
	]);

	const sportsAMMV2ManagerAddress = await sportsAMMV2Manager.getAddress();
	const { defaultCap, defaultRiskMultiplier, maxCap, maxRiskMultiplier } =
		RISK_MANAGER_INITAL_PARAMS;

	const SportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManager = await upgrades.deployProxy(SportsAMMV2RiskManager, [
		owner.address,
		sportsAMMV2ManagerAddress,
		defaultCap,
		defaultRiskMultiplier,
		maxCap,
		maxRiskMultiplier,
	]);

	const collateralAddress = await collateral.getAddress();
	const sportsAMMV2RiskManagerAddress = await sportsAMMV2RiskManager.getAddress();

	const {
		safeBoxFee,
		minBuyInAmount,
		maxTicketSize,
		maxSupportedAmount,
		maxSupportedOdds,
		minimalTimeLeftToMaturity,
		expiryDuration,
	} = SPORTS_AMM_INITAL_PARAMS;

	const SportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = await upgrades.deployProxy(SportsAMMV2, [
		owner.address,
		collateralAddress,
		sportsAMMV2ManagerAddress,
		sportsAMMV2RiskManagerAddress,
		referrals.address,
		stakingThales.address,
		safeBox.address,
	]);

	await sportsAMMV2.setAmounts(
		safeBoxFee,
		minBuyInAmount,
		maxTicketSize,
		maxSupportedAmount,
		maxSupportedOdds
	);

	await sportsAMMV2.setTimes(minimalTimeLeftToMaturity, expiryDuration);

	return {
		owner,
		sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		sportsAMMV2,
		collateral,
		referrals,
		stakingThales,
		safeBox,
	};
}

module.exports = {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
};
