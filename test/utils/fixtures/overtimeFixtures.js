const { upgrades } = require('hardhat');
const { RISK_MANAGER_INITAL_PARAMS } = require('../../constants/overtime');

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.

async function deployAccountsFixture() {
	// Contracts are deployed using the first signer/account by default
	const [owner, secondAccount, thirdAccount, fourthAccount] = await ethers.getSigners();

	return {
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
	};
}

async function deploySportsAMMV2ManagerFixture() {
	const { owner } = await deployAccountsFixture();

	const needsTransformingCollateral = false;

	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const sportsAMMV2Manager = await upgrades.deployProxy(SportsAMMV2Manager, [
		owner.address,
		needsTransformingCollateral,
	]);

	return {
		sportsAMMV2Manager,
		needsTransformingCollateral,
	};
}

async function deploySportsAMMV2RiskManagerFixture() {
	const { owner } = await deployAccountsFixture();
	const { sportsAMMV2Manager } = await deploySportsAMMV2ManagerFixture();

	const sportsAMMV2RiskManagerAddress = await sportsAMMV2Manager.getAddress();
	const { defaultCap, defaultRiskMultiplier, maxCap, maxRiskMultiplier } =
		RISK_MANAGER_INITAL_PARAMS;

	const SportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManager = await upgrades.deployProxy(SportsAMMV2RiskManager, [
		owner.address,
		sportsAMMV2RiskManagerAddress,
		defaultCap,
		defaultRiskMultiplier,
		maxCap,
		maxRiskMultiplier,
	]);

	return {
		sportsAMMV2RiskManager,
		sportsAMMV2Manager,
		defaultCap,
		defaultRiskMultiplier,
		maxCap,
		maxRiskMultiplier,
	};
}

module.exports = {
	deployAccountsFixture,
	deploySportsAMMV2ManagerFixture,
	deploySportsAMMV2RiskManagerFixture,
};
