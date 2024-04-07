const { upgrades, ethers } = require('hardhat');
const {
	RISK_MANAGER_INITAL_PARAMS,
	SPORTS_AMM_INITAL_PARAMS,
	SPORTS_AMM_LP_INITAL_PARAMS,
	SPORTS_AMM_LP_ETH_INITAL_PARAMS,
	SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS,
} = require('../../constants/overtimeContractParams');
const {
	DEFAULT_AMOUNT,
	DEFAULT_AMOUNT_SIX_DECIMALS,
	ETH_DEFAULT_AMOUNT,
} = require('../../constants/overtime');
const { createMerkleTree, getTicketTradeData } = require('../overtime');
const { ZERO_ADDRESS } = require('../../constants/general');

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
	const { collateral, collateralSixDecimals } = await deployTokenFixture();
	const collateralAddress = await collateral.getAddress();
	// deploy Address Manager
	const AddressManager = await ethers.getContractFactory('AddressManagerExtension');
	const addressManager = await upgrades.deployProxy(AddressManager, [
		owner.address,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
	]);
	const addressManagerAddress = await addressManager.getAddress();

	// deploy mock PriceFeed
	const PriceFeed = await ethers.getContractFactory('MockPriceFeed');
	const priceFeed = await PriceFeed.deploy();
	const priceFeedAddress = await priceFeed.getAddress();

	// deploy mock Staking Thales
	const StakingThales = await ethers.getContractFactory('MockStakingThales');
	const stakingThales = await upgrades.deployProxy(StakingThales);

	// deploy mock Referrals
	const Referrals = await ethers.getContractFactory('MockReferrals');
	const referrals = await upgrades.deployProxy(Referrals);

	// deploy WETH collateral
	const WETH = await ethers.getContractFactory('WETH9');
	const weth = await WETH.deploy();
	const wethAddress = await weth.getAddress();

	const collateralSixDecimalsAddress = await collateralSixDecimals.getAddress();

	await priceFeed.setPriceFeedForCollateral(
		ethers.encodeBytes32String('WETH'),
		wethAddress,
		ethers.parseEther('3500')
	);
	await priceFeed.setPriceFeedForCollateral(
		ethers.encodeBytes32String('USDC'),
		collateralSixDecimalsAddress,
		ethers.parseEther('1')
	);
	await priceFeed.setWETH9(wethAddress);

	// deploy mock PriceFeed
	const MultiCollateral = await ethers.getContractFactory('MockMultiCollateralOnOffRamp');
	const multiCollateral = await MultiCollateral.deploy();
	await multiCollateral.setPriceFeed(priceFeedAddress);
	await multiCollateral.setSUSD(collateralAddress);
	await multiCollateral.setCollateralKey(wethAddress, ethers.encodeBytes32String('WETH'));
	await multiCollateral.setCollateralKey(
		collateralSixDecimalsAddress,
		ethers.encodeBytes32String('USDC')
	);
	const multiCollateralAddress = await multiCollateral.getAddress();

	// deploy Sports AMM manager
	const SportsAMMV2Manager = await ethers.getContractFactory('SportsAMMV2Manager');
	const sportsAMMV2Manager = await upgrades.deployProxy(SportsAMMV2Manager, [owner.address]);

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

	// deploy Sports AMM result manager
	const SportsAMMV2ResultManager = await ethers.getContractFactory('SportsAMMV2ResultManager');
	const sportsAMMV2ResultManager = await upgrades.deployProxy(SportsAMMV2ResultManager, [
		owner.address,
		sportsAMMV2ManagerAddress,
	]);

	// deploy Sports AMM
	const sportsAMMV2RiskManagerAddress = await sportsAMMV2RiskManager.getAddress();
	const sportsAMMV2ResultManagerAddress = await sportsAMMV2ResultManager.getAddress();
	const stakingThalesAddress = await stakingThales.getAddress();
	const referralsAddress = await referrals.getAddress();
	await addressManager.setAddressInAddressBook('StakingThales', stakingThalesAddress, {
		from: owner.address,
	});
	await addressManager.setAddressInAddressBook('Refferals', referralsAddress, {
		from: owner.address,
	});
	await addressManager.setAddressInAddressBook('SafeBox', safeBox, { from: owner.address });
	await addressManager.setAddressInAddressBook('PriceFeed', priceFeedAddress, {
		from: owner.address,
	});

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

	await sportsAMMV2.setMultiCollateralOnOffRamp(multiCollateralAddress, true);
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
			_addressManager: addressManagerAddress,
			_collateral: collateralAddress,
			_collateralKey: ethers.encodeBytes32String('SUSD'),
			_roundLength: SPORTS_AMM_LP_INITAL_PARAMS.roundLength,
			_maxAllowedDeposit: SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedDeposit,
			_minDepositAmount: SPORTS_AMM_LP_INITAL_PARAMS.minDepositAmount,
			_maxAllowedUsers: SPORTS_AMM_LP_INITAL_PARAMS.maxAllowedUsers,
			_utilizationRate: SPORTS_AMM_LP_INITAL_PARAMS.utilizationRate,
			_safeBox: safeBox.address,
			_safeBoxImpact: SPORTS_AMM_LP_INITAL_PARAMS.safeBoxImpact,
		},
	]);

	const sportsAMMV2LiquidityPoolSixDecimals = await upgrades.deployProxy(SportsAMMV2LiquidityPool, [
		{
			_owner: owner.address,
			_sportsAMM: sportsAMMV2Address,
			_addressManager: addressManagerAddress,
			_collateral: collateralSixDecimalsAddress,
			_collateralKey: ethers.encodeBytes32String('USDC'),
			_roundLength: SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS.roundLength,
			_maxAllowedDeposit: SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS.maxAllowedDeposit,
			_minDepositAmount: SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS.minDepositAmount,
			_maxAllowedUsers: SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS.maxAllowedUsers,
			_utilizationRate: SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS.utilizationRate,
			_safeBox: safeBox.address,
			_safeBoxImpact: SPORTS_AMM_LP_SIX_DEC_INITAL_PARAMS.safeBoxImpact,
		},
	]);

	const sportsAMMV2LiquidityPoolAddress = await sportsAMMV2LiquidityPool.getAddress();
	const sportsAMMV2LiquidityPoolSixDecimalsAddress =
		await sportsAMMV2LiquidityPoolSixDecimals.getAddress();

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
	sportsAMMV2LiquidityPoolSixDecimals.setPoolRoundMastercopy(
		sportsAMMV2LiquidityPoolRoundMastercopyAddress
	);

	// deploy default liqudity provider
	const DefaultLiquidityProvider = await ethers.getContractFactory('DefaultLiquidityProvider');
	const defaultLiquidityProvider = await upgrades.deployProxy(DefaultLiquidityProvider, [
		owner.address,
		sportsAMMV2LiquidityPoolAddress,
		collateralAddress,
	]);
	const defaultLiquidityProviderSixDecimals = await upgrades.deployProxy(DefaultLiquidityProvider, [
		owner.address,
		sportsAMMV2LiquidityPoolSixDecimalsAddress,
		collateralSixDecimalsAddress,
	]);

	const defaultLiquidityProviderAddress = defaultLiquidityProvider.getAddress();
	await sportsAMMV2LiquidityPool.setDefaultLiquidityProvider(defaultLiquidityProviderAddress);

	const defaultLiquidityProviderSixDecimalsAddress =
		defaultLiquidityProviderSixDecimals.getAddress();
	await sportsAMMV2LiquidityPoolSixDecimals.setDefaultLiquidityProvider(
		defaultLiquidityProviderSixDecimalsAddress
	);

	// deploy Sports AMM Data

	const SportsAMMV2Data = await ethers.getContractFactory('SportsAMMV2Data');
	const sportsAMMV2Data = await upgrades.deployProxy(SportsAMMV2Data, [
		owner.address,
		sportsAMMV2Address,
	]);

	const root = await createMerkleTree();
	const {
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound,
		tradeIllegalCombinationCurrentRound,
		sameGameDifferentPlayerProps,
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
	await collateralSixDecimals.setDefaultAmount(DEFAULT_AMOUNT_SIX_DECIMALS);
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

	await collateralSixDecimals.mintForUser(firstLiquidityProvider);
	await collateralSixDecimals.mintForUser(secondLiquidityProvider);
	await collateralSixDecimals.mintForUser(thirdLiquidityProvider);
	await collateralSixDecimals
		.connect(firstLiquidityProvider)
		.approve(sportsAMMV2LiquidityPoolSixDecimals, DEFAULT_AMOUNT_SIX_DECIMALS);
	await collateralSixDecimals
		.connect(secondLiquidityProvider)
		.approve(sportsAMMV2LiquidityPoolSixDecimals, DEFAULT_AMOUNT_SIX_DECIMALS);
	await collateralSixDecimals
		.connect(thirdLiquidityProvider)
		.approve(sportsAMMV2LiquidityPoolSixDecimals, DEFAULT_AMOUNT_SIX_DECIMALS);

	await collateral.mintForUser(firstTrader);
	await collateral.mintForUser(secondTrader);
	await collateral.connect(firstTrader).approve(sportsAMMV2, DEFAULT_AMOUNT);
	await collateral.connect(secondTrader).approve(sportsAMMV2, DEFAULT_AMOUNT);

	await collateralSixDecimals.mintForUser(firstTrader);
	await collateralSixDecimals.mintForUser(secondTrader);
	await collateralSixDecimals
		.connect(firstTrader)
		.approve(sportsAMMV2, DEFAULT_AMOUNT_SIX_DECIMALS);
	await collateralSixDecimals
		.connect(secondTrader)
		.approve(sportsAMMV2, DEFAULT_AMOUNT_SIX_DECIMALS);

	await collateral.mintForUser(owner);
	await collateral.transfer(await defaultLiquidityProvider.getAddress(), DEFAULT_AMOUNT);

	await collateralSixDecimals.mintForUser(owner);
	await collateralSixDecimals.transfer(
		await defaultLiquidityProviderSixDecimals.getAddress(),
		DEFAULT_AMOUNT_SIX_DECIMALS
	);

	// send collateral to multicollateral so it can convert other collaterals
	await collateral.mintForUser(owner);
	await collateral.transfer(multiCollateralAddress, DEFAULT_AMOUNT);

	await collateralSixDecimals.mintForUser(owner);
	await collateralSixDecimals.transfer(multiCollateralAddress, DEFAULT_AMOUNT_SIX_DECIMALS);

	const SportsAMMV2LiquidityPoolETH = await ethers.getContractFactory('SportsAMMV2LiquidityPool');

	const sportsAMMV2LiquidityPoolETH = await upgrades.deployProxy(SportsAMMV2LiquidityPoolETH, [
		{
			_owner: owner.address,
			_sportsAMM: sportsAMMV2Address,
			_addressManager: addressManagerAddress,
			_collateral: wethAddress,
			_collateralKey: ethers.encodeBytes32String('ETH'),
			_roundLength: SPORTS_AMM_LP_ETH_INITAL_PARAMS.roundLength,
			_maxAllowedDeposit: SPORTS_AMM_LP_ETH_INITAL_PARAMS.maxAllowedDeposit,
			_minDepositAmount: SPORTS_AMM_LP_ETH_INITAL_PARAMS.minDepositAmount,
			_maxAllowedUsers: SPORTS_AMM_LP_ETH_INITAL_PARAMS.maxAllowedUsers,
			_utilizationRate: SPORTS_AMM_LP_ETH_INITAL_PARAMS.utilizationRate,
			_safeBox: safeBox.address,
			_safeBoxImpact: SPORTS_AMM_LP_ETH_INITAL_PARAMS.safeBoxImpact,
		},
	]);

	const sportsAMMV2LiquidityPoolETHAddress = await sportsAMMV2LiquidityPoolETH.getAddress();

	await sportsAMMV2.setCollateralLiquidityPool(collateralAddress, sportsAMMV2LiquidityPoolAddress);
	await sportsAMMV2.setCollateralLiquidityPool(wethAddress, sportsAMMV2LiquidityPoolETHAddress);

	await sportsAMMV2LiquidityPoolETH.setPoolRoundMastercopy(
		sportsAMMV2LiquidityPoolRoundMastercopyAddress
	);
	await sportsAMMV2LiquidityPoolETH.setCanDepositETH(true);
	// deploy default liqudity provider
	const defaultLiquidityProviderETH = await upgrades.deployProxy(DefaultLiquidityProvider, [
		owner.address,
		sportsAMMV2LiquidityPoolETHAddress,
		wethAddress,
	]);

	const defaultLiquidityProviderETHAddress = await defaultLiquidityProviderETH.getAddress();
	await sportsAMMV2LiquidityPoolETH.setDefaultLiquidityProvider(defaultLiquidityProviderETHAddress);

	await weth.deposit({ value: ETH_DEFAULT_AMOUNT });
	await weth.transfer(defaultLiquidityProviderETHAddress, ETH_DEFAULT_AMOUNT);

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
		sportsAMMV2LiquidityPoolSixDecimals,
		sportsAMMV2LiquidityPoolRoundMastercopy,
		defaultLiquidityProvider,
		defaultLiquidityProviderSixDecimals,
		sportsAMMV2LiquidityPoolETH,
		defaultLiquidityProviderETH,
		weth,
		collateral,
		collateralSixDecimals,
		multiCollateral,
		priceFeed,
		referrals,
		stakingThales,
		safeBox,
		addressManager,
		tradeDataCurrentRound,
		tradeDataNextRound,
		tradeDataCrossRounds,
		tradeDataTenMarketsCurrentRound,
		liveTradingProcessor,
		mockChainlinkOracle,
		sportsAMMV2Data,
		tradeIllegalCombinationCurrentRound,
		sameGameDifferentPlayerProps,
		sameGameSamePlayersDifferentProps,
	};
}

module.exports = {
	deployAccountsFixture,
	deployTokenFixture,
	deploySportsAMMV2Fixture,
};
