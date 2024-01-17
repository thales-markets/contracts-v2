const { upgrades } = require('hardhat');
const {
	RISK_MANAGER_INITAL_PARAMS,
	SPORTS_AMM_INITAL_PARAMS,
	MANAGER_INITAL_PARAMS,
	SPORTS_AMM_LP_INITAL_PARAMS,
} = require('../../constants/overtimeContractParams');
const { getMerkleTreeRoot } = require('../merkleTree/merkleTree');
const { GAME_ID_1, DEFAULT_AMOUNT } = require('../../constants/overtime');
const { time } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { createMerkleTree, getTicketTradeDataCurrentRound } = require('../overtime');

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
		safeBox,
		firstLiquidityProvider,
		secondLiquidityProvider,
		thirdLiquidityProvider,
		firstTrader,
		secondTrader,
	] = await ethers.getSigners();

	return {
		owner,
		secondAccount,
		thirdAccount,
		fourthAccount,
		fifthAccount,
		safeBox,
		firstLiquidityProvider,
		secondLiquidityProvider,
		thirdLiquidityProvider,
		firstTrader,
		secondTrader,
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
	const {
		owner,
		safeBox,
		firstLiquidityProvider,
		secondLiquidityProvider,
		thirdLiquidityProvider,
		firstTrader,
		secondTrader,
	} = await deployAccountsFixture();
	const { collateral } = await deployTokenFixture();

	// deploy mock Staking Thales
	const StakingThales = await ethers.getContractFactory('MockStakingThales');
	const stakingThales = await upgrades.deployProxy(StakingThales);

	// deploy mock Referrals
	const Referrals = await ethers.getContractFactory('MockReferrals');
	const referrals = await upgrades.deployProxy(Referrals);

	// deploy Sports AMM manager
	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const sportsAMMV2Manager = await upgrades.deployProxy(SportsAMMV2Manager, [
		owner.address,
		MANAGER_INITAL_PARAMS.needsTransformingCollateral,
	]);

	// deploy Sports AMM risk manager
	const sportsAMMV2ManagerAddress = await sportsAMMV2Manager.getAddress();

	const SportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManager = await upgrades.deployProxy(SportsAMMV2RiskManager, [
		owner.address,
		sportsAMMV2ManagerAddress,
		RISK_MANAGER_INITAL_PARAMS.defaultCap,
		RISK_MANAGER_INITAL_PARAMS.defaultRiskMultiplier,
		RISK_MANAGER_INITAL_PARAMS.maxCap,
		RISK_MANAGER_INITAL_PARAMS.maxRiskMultiplier,
	]);

	// deploy Sports AMM
	const collateralAddress = await collateral.getAddress();
	const sportsAMMV2RiskManagerAddress = await sportsAMMV2RiskManager.getAddress();
	const stakingThalesAddress = await stakingThales.getAddress();
	const referralsAddress = await referrals.getAddress();

	const SportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = await upgrades.deployProxy(SportsAMMV2, [
		owner.address,
		collateralAddress,
		sportsAMMV2ManagerAddress,
		sportsAMMV2RiskManagerAddress,
		referralsAddress,
		stakingThalesAddress,
		safeBox.address,
	]);

	await sportsAMMV2.setAmounts(
		SPORTS_AMM_INITAL_PARAMS.safeBoxFee,
		SPORTS_AMM_INITAL_PARAMS.minBuyInAmount,
		SPORTS_AMM_INITAL_PARAMS.maxTicketSize,
		SPORTS_AMM_INITAL_PARAMS.maxSupportedAmount,
		SPORTS_AMM_INITAL_PARAMS.maxSupportedOdds
	);
	await sportsAMMV2.setTimes(
		SPORTS_AMM_INITAL_PARAMS.minimalTimeLeftToMaturity,
		SPORTS_AMM_INITAL_PARAMS.expiryDuration
	);

	// deploy ticket mastercopy
	const TicketMastercopy = await ethers.getContractFactory('TicketMastercopy');
	const ticketMastercopy = await TicketMastercopy.deploy();

	const ticketMastercopyAddress = await ticketMastercopy.getAddress();
	sportsAMMV2.setTicketMastercopy(ticketMastercopyAddress);

	// deploy Sports AMM liqudity pool
	const sportsAMMV2Address = await sportsAMMV2.getAddress();

	const SportsAMMV2LiquidityPool = await ethers.getContractFactory('SportsAMMV2LiquidityPool');
	const sportsAMMV2LiquidityPool = await upgrades.deployProxy(SportsAMMV2LiquidityPool, [
		{
			_owner: owner.address,
			_sportsAMM: sportsAMMV2Address,
			_stakingThales: stakingThalesAddress,
			_collateral: collateralAddress,
			_roundLength: SPORTS_AMM_LP_INITAL_PARAMS.roundLength,
			_maxAllowedDeposit: SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedDeposit,
			_minDepositAmount: SPORTS_AMM_LP_INITAL_PARAMS.minDepositAmount,
			_maxAllowedUsers: SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedUsers,
			_utilizationRate: SPORTS_AMM_LP_INITAL_PARAMS.utilizationRate,
			_safeBox: safeBox.address,
			_safeBoxImpact: SPORTS_AMM_LP_INITAL_PARAMS.safeBoxImpact,
		},
	]);

	const sportsAMMV2LiquidityPoolAddress = await sportsAMMV2LiquidityPool.getAddress();
	await sportsAMMV2.setLiquidityPool(sportsAMMV2LiquidityPoolAddress);

	// deploy Sports AMM liqudity pool round mastercopy
	const SportsAMMV2LiquidityPoolRoundMastercopy = await ethers.getContractFactory(
		'SportsAMMV2LiquidityPoolRoundMastercopy'
	);
	const sportsAMMV2LiquidityPoolRoundMastercopy =
		await SportsAMMV2LiquidityPoolRoundMastercopy.deploy();

	const sportsAMMV2LiquidityPoolRoundMastercopyAddress =
		await sportsAMMV2LiquidityPoolRoundMastercopy.getAddress();
	sportsAMMV2LiquidityPool.setPoolRoundMastercopy(sportsAMMV2LiquidityPoolRoundMastercopyAddress);

	// deploy default liqudity provider
	const DefaultLiquidityProvider = await ethers.getContractFactory('DefaultLiquidityProvider');
	const defaultLiquidityProvider = await upgrades.deployProxy(DefaultLiquidityProvider, [
		owner.address,
		sportsAMMV2LiquidityPoolAddress,
		collateralAddress,
	]);

	const defaultLiquidityProviderAddress = defaultLiquidityProvider.getAddress();
	await sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(defaultLiquidityProviderAddress);

	const root = await createMerkleTree();
	const tradeDataCurrentRound = getTicketTradeDataCurrentRound();

	// set new root on Sports AMM contract
	await sportsAMMV2.setRootPerGame(GAME_ID_1, root);

	await collateral.setDefaultAmount(DEFAULT_AMOUNT);
	await collateral.mintForUser(firstLiquidityProvider);
	await collateral.mintForUser(secondLiquidityProvider);
	await collateral.mintForUser(thirdLiquidityProvider);
	await collateral
		.connect(firstLiquidityProvider)
		.approve(sportsAMMV2LiquidityPool, DEFAULT_AMOUNT);
	await collateral
		.connect(secondLiquidityProvider)
		.approve(sportsAMMV2LiquidityPool, DEFAULT_AMOUNT);
	await collateral
		.connect(thirdLiquidityProvider)
		.approve(sportsAMMV2LiquidityPool, DEFAULT_AMOUNT);

	await collateral.mintForUser(firstTrader);
	await collateral.mintForUser(secondTrader);
	await collateral.connect(firstTrader).approve(sportsAMMV2, DEFAULT_AMOUNT);
	await collateral.connect(secondTrader).approve(sportsAMMV2, DEFAULT_AMOUNT);

	return {
		owner,
		sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		sportsAMMV2,
		ticketMastercopy,
		sportsAMMV2LiquidityPool,
		sportsAMMV2LiquidityPoolRoundMastercopy,
		defaultLiquidityProvider,
		collateral,
		referrals,
		stakingThales,
		safeBox,
		tradeDataCurrentRound,
	};
}

module.exports = {
	deployAccountsFixture,
	deploySportsAMMV2Fixture,
};
