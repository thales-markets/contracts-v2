const { upgrades } = require('hardhat');
const {
	RISK_MANAGER_INITAL_PARAMS,
	SPORTS_AMM_INITAL_PARAMS,
	SPORTS_AMM_LP_INITAL_PARAMS,
} = require('../../constants/overtimeContractParams');
const { DEFAULT_AMOUNT } = require('../../constants/overtime');
const { createMerkleTree, getTicketTradeData } = require('../overtime');

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
	const sportsAMMV2Manager = await upgrades.deployProxy(SportsAMMV2Manager, [owner.address]);
	const sportsAMMV2ManagerAddress = await sportsAMMV2Manager.getAddress();

	// deploy Sports AMM result manager
	const SportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManager = await upgrades.deployProxy(SportsAMMV2ResultManager, [
		owner.address,
		sportsAMMV2ManagerAddress,
	]);
	const sportsAMMV2ResultManagerAddress = await sportsAMMV2ResultManager.getAddress();

	// deploy Sports AMM risk manager
	const SportsAMMV2RiskManager = await ethers.getContractFactory('SportsAMMV2RiskManager');
	const sportsAMMV2RiskManager = await upgrades.deployProxy(SportsAMMV2RiskManager, [
		owner.address,
		sportsAMMV2ManagerAddress,
		sportsAMMV2ResultManagerAddress,
		RISK_MANAGER_INITAL_PARAMS.defaultCap,
		RISK_MANAGER_INITAL_PARAMS.defaultRiskMultiplier,
		RISK_MANAGER_INITAL_PARAMS.maxCap,
		RISK_MANAGER_INITAL_PARAMS.maxRiskMultiplier,
	]);
	const sportsAMMV2RiskManagerAddress = await sportsAMMV2RiskManager.getAddress();

	await sportsAMMV2RiskManager.setTicketParams(
		RISK_MANAGER_INITAL_PARAMS.minBuyInAmount,
		RISK_MANAGER_INITAL_PARAMS.maxTicketSize,
		RISK_MANAGER_INITAL_PARAMS.maxSupportedAmount,
		RISK_MANAGER_INITAL_PARAMS.maxSupportedOdds
	);
	await sportsAMMV2RiskManager.setTimes(
		RISK_MANAGER_INITAL_PARAMS.minimalTimeLeftToMaturity,
		RISK_MANAGER_INITAL_PARAMS.expiryDuration
	);

	// deploy Sports AMM
	const collateralAddress = await collateral.getAddress();
	const stakingThalesAddress = await stakingThales.getAddress();
	const referralsAddress = await referrals.getAddress();

	const SportsAMMV2 = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = await upgrades.deployProxy(SportsAMMV2, [
		owner.address,
		collateralAddress,
		sportsAMMV2ManagerAddress,
		sportsAMMV2RiskManagerAddress,
		sportsAMMV2ResultManagerAddress,
		referralsAddress,
		stakingThalesAddress,
		safeBox.address,
	]);
	const sportsAMMV2Address = await sportsAMMV2.getAddress();

	await sportsAMMV2.setAmounts(SPORTS_AMM_INITAL_PARAMS.safeBoxFee);
	await sportsAMMV2RiskManager.setSportsAMM(sportsAMMV2Address);

	// deploy ticket mastercopy
	const TicketMastercopy = await ethers.getContractFactory('TicketMastercopy');
	const ticketMastercopy = await TicketMastercopy.deploy();

	const ticketMastercopyAddress = await ticketMastercopy.getAddress();
	sportsAMMV2.setTicketMastercopy(ticketMastercopyAddress);

	// deploy Sports AMM liqudity pool
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

	// deploy Sports AMM Data
	const SportsAMMV2Data = await ethers.getContractFactory('SportsAMMV2Data');
	const sportsAMMV2Data = await upgrades.deployProxy(SportsAMMV2Data, [
		owner.address,
		sportsAMMV2Address,
		sportsAMMV2RiskManagerAddress,
	]);

	const root = await createMerkleTree();
	const {
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound,
		tradeDataSameGames,
		sameGameWithFirstPlayerProps,
		sameGameWithSecondPlayerProps,
		sameGameDifferentPlayersDifferentProps,
		sameGameSamePlayersDifferentProps,
	} = getTicketTradeData();

	const gameIds = [];
	const roots = [];

	const allTradeData = [
		...tradeDataCurrentRound,
		...tradeDataNextRound,
		...tradeDataCrossRounds,
		...tradeDataTenMarketsCurrentRound,
	];

	for (let index = 0; index < allTradeData.length; index++) {
		const market = allTradeData[index];
		gameIds.push(market.gameId);
		roots.push(root);
	}

	// set new roots on Sports AMM contract
	await sportsAMMV2.setRootsPerGames(gameIds, roots);

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

	await collateral.mintForUser(owner);
	await collateral.transfer(await defaultLiquidityProvider.getAddress(), DEFAULT_AMOUNT);

	// deploy LiveTradingProcessor

	const MockChainlinkOracle = await ethers.getContractFactory('MockChainlinkOracle');
	const mockChainlinkOracle = await MockChainlinkOracle.deploy();

	const mockChainlinkOracleAddress = mockChainlinkOracle.getAddress();

	const mockSpecId = '0x7370656349640000000000000000000000000000000000000000000000000000';
	const LiveTradingProcessor = await ethers.getContractFactory('LiveTradingProcessor');
	//	//constructor(address _link, address _oracle, address _sportsAMM, bytes32 _specId, uint _payment) Ownable(msg.sender) {
	const liveTradingProcessor = await LiveTradingProcessor.deploy(
		collateralAddress, //link
		mockChainlinkOracleAddress, //_oracle
		sportsAMMV2Address, // _sportsAMM
		mockSpecId, // _specId
		0 // payment
	);

	const liveTradingProcessorAddress = liveTradingProcessor.getAddress();

	await mockChainlinkOracle.setLiveTradingProcessor(liveTradingProcessorAddress);
	await sportsAMMV2.setLiveTradingProcessor(liveTradingProcessorAddress);

	return {
		owner,
		sportsAMMV2Manager,
		sportsAMMV2RiskManager,
		sportsAMMV2ResultManager,
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
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound,
		liveTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2Data,
		tradeDataSameGames,
		sameGameWithFirstPlayerProps,
		sameGameWithSecondPlayerProps,
		sameGameDifferentPlayersDifferentProps,
		sameGameSamePlayersDifferentProps,
	};
}

module.exports = {
	deployAccountsFixture,
	deployTokenFixture,
	deploySportsAMMV2Fixture,
};
