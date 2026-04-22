// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "chainlink-vrf/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import "chainlink-vrf/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// internal
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "@thales-dao/contracts/contracts/interfaces/IPriceFeed.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";

/// @title Dice
/// @author Overtime
/// @notice d20 dice contract using Chainlink VRF for single-player bets
/// @dev Supports USDC, WETH and OVER collateral, with bankroll reservation per collateral
contract Dice is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant USDC_UNIT = 1e6;
    uint8 private constant DICE_SIDES = 20;

    /// @notice Minimum allowed bet value expressed in USD, normalized to 18 decimals
    uint public constant MIN_BET_USD = 3e18;

    /// @notice Maximum allowed house edge in 1e18 precision
    uint public constant MAX_HOUSE_EDGE = 5e16; // 5%

    /// @notice Minimum allowed cancel timeout in seconds
    uint public constant MIN_CANCEL_TIMEOUT = 30;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidCollateral();
    error InvalidPrice();
    error InvalidAmount();
    error InvalidBetType();
    error InvalidTarget();
    error InvalidResult();
    error InvalidHouseEdge();
    error BetNotFound();
    error BetNotPending();
    error BetNotOwner();
    error CancelTimeoutNotReached();
    error MaxProfitExceeded();
    error InsufficientAvailableLiquidity();

    /* ========== ENUMS ========== */

    /// @notice Supported dice bet types
    enum BetType {
        ROLL_UNDER,
        ROLL_OVER
    }

    /// @notice Lifecycle status of a dice bet
    enum BetStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    /* ========== STRUCTS ========== */

    /// @notice Stored data for an individual dice bet
    /// @param user Address of the bettor
    /// @param collateral Collateral token used for the bet
    /// @param amount Amount staked
    /// @param payout Final payout amount, 0 if lost, original amount if cancelled
    /// @param requestId Chainlink VRF request id
    /// @param placedAt Timestamp when the bet was placed
    /// @param resolvedAt Timestamp when the bet was resolved or cancelled
    /// @param reservedProfit Reserved house-side profit liability for this bet
    /// @param betType Type of dice bet
    /// @param status Current status of the bet
    /// @param target Encoded target for the chosen bet type
    /// @param result Winning dice result in range 1..20
    /// @param won Whether the bet won
    struct Bet {
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint requestId;
        uint placedAt;
        uint resolvedAt;
        uint reservedProfit;
        BetType betType;
        BetStatus status;
        uint8 target;
        uint8 result;
        bool won;
    }

    struct CoreAddresses {
        address owner;
        address manager;
        address priceFeed;
        address vrfCoordinator;
    }

    struct CollateralConfig {
        address usdc;
        address weth;
        address over;
        bytes32 wethPriceFeedKey;
        bytes32 overPriceFeedKey;
    }

    struct VrfConfig {
        uint256 subscriptionId;
        bytes32 keyHash;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
        bool nativePayment;
    }

    /* ========== STATE VARIABLES ========== */

    /// @notice Manager contract used for whitelist-based role checks
    ISportsAMMV2Manager public manager;

    /// @notice Price feed used for collateral normalization to USD
    IPriceFeed public priceFeed;

    /// @notice Chainlink VRF coordinator
    IVRFCoordinatorV2Plus public vrfCoordinator;

    /// @notice Supported collateral addresses
    address public usdc;
    address public weth;
    address public over;

    /// @notice Maximum allowed profit per bet in USD, normalized to 18 decimals
    uint public maxProfitUsd;

    /// @notice Timeout after which a pending bet can be cancelled
    uint public cancelTimeout;

    /// @notice House edge in 1e18 precision. Example: 1e16 = 1%
    /// @dev Must be greater than 0 and capped at MAX_HOUSE_EDGE
    uint public houseEdge;

    /// @notice Next bet id to assign
    uint public nextBetId;

    /// @notice Chainlink VRF v2.5 subscription id
    uint256 public subscriptionId;

    /// @notice Chainlink VRF key hash / gas lane
    bytes32 public keyHash;

    /// @notice Gas limit for VRF callback execution
    uint32 public callbackGasLimit;

    /// @notice Number of confirmations for VRF request
    uint16 public requestConfirmations;

    /// @notice Whether VRF request is paid in native token
    bool public nativePayment;

    /// @notice Whether a collateral is supported
    mapping(address => bool) public supportedCollateral;

    /// @notice Price feed key per collateral for non-USDC assets
    mapping(address => bytes32) public priceFeedKeyPerCollateral;

    /// @notice Stored bets by bet id
    mapping(uint => Bet) internal bets;

    /// @notice Maps VRF request id to bet id
    mapping(uint => uint) public requestIdToBetId;

    /// @notice Tracks reserved house-side profit liability for all pending bets per collateral
    mapping(address => uint) public reservedProfitPerCollateral;

    /// @notice Bet IDs per user for history queries
    mapping(address => uint[]) private userBetIds;

    /// @notice Free bets holder contract address
    address public freeBetsHolder;

    /// @notice Whether a bet was placed with a free bet
    mapping(uint => bool) public isFreeBet;

    /// @notice Referrals contract
    IReferrals public referrals;

    /* ========== PUBLIC / EXTERNAL METHODS ========== */

    /// @notice Initializes the dice contract
    /// @param core Core protocol addresses
    /// @param collateralConfig Collateral addresses and price feed keys
    /// @param _maxProfitUsd Maximum allowed profit per bet in USD, normalized to 18 decimals
    /// @param _cancelTimeout Timeout after which a pending bet can be cancelled
    /// @param _houseEdge House edge in 1e18 precision. Example: 1e16 = 1%
    /// @param vrfConfig Chainlink VRF configuration
    function initialize(
        CoreAddresses calldata core,
        CollateralConfig calldata collateralConfig,
        uint _maxProfitUsd,
        uint _cancelTimeout,
        uint _houseEdge,
        VrfConfig calldata vrfConfig
    ) external initializer {
        if (
            core.owner == address(0) ||
            core.manager == address(0) ||
            core.priceFeed == address(0) ||
            core.vrfCoordinator == address(0) ||
            collateralConfig.usdc == address(0) ||
            collateralConfig.weth == address(0) ||
            collateralConfig.over == address(0)
        ) {
            revert InvalidAddress();
        }

        if (_maxProfitUsd == 0) revert InvalidAmount();
        if (_houseEdge == 0 || _houseEdge > MAX_HOUSE_EDGE) revert InvalidHouseEdge();
        if (vrfConfig.callbackGasLimit == 0) revert InvalidAmount();

        setOwner(core.owner);
        initNonReentrant();

        manager = ISportsAMMV2Manager(core.manager);
        priceFeed = IPriceFeed(core.priceFeed);
        vrfCoordinator = IVRFCoordinatorV2Plus(core.vrfCoordinator);

        usdc = collateralConfig.usdc;
        weth = collateralConfig.weth;
        over = collateralConfig.over;

        supportedCollateral[collateralConfig.usdc] = true;
        supportedCollateral[collateralConfig.weth] = true;
        supportedCollateral[collateralConfig.over] = true;

        priceFeedKeyPerCollateral[collateralConfig.weth] = collateralConfig.wethPriceFeedKey;
        priceFeedKeyPerCollateral[collateralConfig.over] = collateralConfig.overPriceFeedKey;

        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        cancelTimeout = _cancelTimeout;
        houseEdge = _houseEdge;

        subscriptionId = vrfConfig.subscriptionId;
        keyHash = vrfConfig.keyHash;
        callbackGasLimit = vrfConfig.callbackGasLimit;
        requestConfirmations = vrfConfig.requestConfirmations;
        nativePayment = vrfConfig.nativePayment;

        nextBetId = 1;
    }

    /// @notice Places a dice bet and requests randomness from Chainlink VRF
    function placeBet(
        address collateral,
        uint amount,
        BetType betType,
        uint8 target,
        address _referrer
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        _setReferrer(_referrer, msg.sender);
        return _placeBet(msg.sender, collateral, amount, betType, target, false);
    }

    /// @notice Places a dice bet using free bet balance
    function placeBetWithFreeBet(
        address collateral,
        uint amount,
        BetType betType,
        uint8 target
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, amount);
        return _placeBet(msg.sender, collateral, amount, betType, target, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint amount,
        BetType betType,
        uint8 target,
        bool _isFreeBet
    ) internal returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        if (amount == 0) revert InvalidAmount();
        _validateTarget(betType, target);
        if (_getUsdValue(collateral, amount) < MIN_BET_USD) revert InvalidAmount();

        uint reservedProfit = _getReservedProfit(amount, betType, target);
        if (_getUsdValue(collateral, reservedProfit) > maxProfitUsd) revert MaxProfitExceeded();

        reservedProfitPerCollateral[collateral] += reservedProfit;
        if (!_hasEnoughLiquidity(collateral)) {
            reservedProfitPerCollateral[collateral] -= reservedProfit;
            revert InsufficientAvailableLiquidity();
        }

        requestId = _requestRandomWord();
        betId = nextBetId++;

        Bet storage bet = bets[betId];
        bet.user = user;
        bet.collateral = collateral;
        bet.amount = amount;
        bet.requestId = requestId;
        bet.placedAt = block.timestamp;
        bet.reservedProfit = reservedProfit;
        bet.betType = betType;
        bet.status = BetStatus.PENDING;
        bet.target = target;

        if (_isFreeBet) isFreeBet[betId] = true;

        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        emit BetPlaced(betId, requestId, user, collateral, amount, betType, target);
    }

    /// @notice Cancels a pending bet after timeout and refunds the original stake
    /// @param betId Bet id to cancel
    function cancelBet(uint betId) external nonReentrant {
        Bet storage bet = bets[betId];

        if (bet.status == BetStatus.NONE) revert BetNotFound();
        if (bet.user != msg.sender) revert BetNotOwner();
        if (bet.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < bet.placedAt + cancelTimeout) revert CancelTimeoutNotReached();

        _cancelBet(betId, false);
    }

    /// @notice Emergency cancels a pending bet and refunds the original stake
    /// @dev Callable by owner or manager role with MARKET_RESOLVING permission
    /// @param betId Bet id to cancel
    function adminCancelBet(uint betId) external onlyResolver nonReentrant {
        Bet storage bet = bets[betId];

        if (bet.status == BetStatus.NONE) revert BetNotFound();
        if (bet.status != BetStatus.PENDING) revert BetNotPending();

        _cancelBet(betId, true);
    }

    /// @notice Pauses or unpauses the contract using manager-based pauser permissions
    /// @param _paused True to pause, false to unpause
    function setPausedByRole(bool _paused) external onlyPauser {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                lastPauseTime = block.timestamp;
            }
            emit PauseChanged(_paused);
        }
    }

    /// @notice Coordinator-only VRF entrypoint
    /// @param requestId Chainlink VRF request id
    /// @param randomWords Array of VRF random words
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert InvalidSender();
        _fulfillRandomWords(requestId, randomWords);
    }

    /* ========== INTERNAL / PRIVATE ========== */

    /// @notice Internal dice resolution logic after VRF fulfillment
    /// @param requestId Chainlink VRF request id
    /// @param randomWords Array of VRF random words
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal {
        uint betId = requestIdToBetId[requestId];
        if (betId == 0) {
            return;
        }

        Bet storage bet = bets[betId];

        if (bet.status != BetStatus.PENDING) {
            return;
        }

        uint8 result = uint8((randomWords[0] % DICE_SIDES) + 1);
        bool won = _isWinning(bet.betType, bet.target, result);

        reservedProfitPerCollateral[bet.collateral] -= bet.reservedProfit;

        uint payout = 0;
        if (won) {
            payout = bet.amount + bet.reservedProfit;
            if (isFreeBet[betId]) {
                IERC20(bet.collateral).safeTransfer(freeBetsHolder, payout);
                IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(bet.user, bet.collateral, payout, bet.amount);
            } else {
                IERC20(bet.collateral).safeTransfer(bet.user, payout);
            }
        }

        if (!won && !isFreeBet[betId]) {
            _payReferrer(bet.user, bet.collateral, bet.amount);
        }

        bet.result = result;
        bet.won = won;
        bet.payout = payout;
        bet.status = BetStatus.RESOLVED;
        bet.resolvedAt = block.timestamp;

        emit BetResolved(betId, requestId, bet.user, result, won, payout);
    }

    function _setReferrer(address _referrer, address _user) internal {
        if (_referrer != address(0) && address(referrals) != address(0)) {
            referrals.setReferrer(_referrer, _user);
        }
    }

    function _payReferrer(address _user, address _collateral, uint _amount) internal {
        if (address(referrals) == address(0)) return;
        address referrer = referrals.referrals(_user);
        if (referrer == address(0)) return;
        uint referrerFee = referrals.getReferrerFee(referrer);
        if (referrerFee == 0) return;
        uint referrerAmount = (_amount * referrerFee) / ONE;
        if (referrerAmount > 0) {
            IERC20(_collateral).safeTransfer(referrer, referrerAmount);
            emit ReferrerPaid(referrer, _user, referrerAmount, _amount, _collateral);
        }
    }

    /// @notice Cancels a pending bet, releases reserved liquidity and refunds stake
    /// @param betId Bet id to cancel
    /// @param adminCancelled Whether the cancellation was admin-triggered
    function _cancelBet(uint betId, bool adminCancelled) internal {
        Bet storage bet = bets[betId];

        reservedProfitPerCollateral[bet.collateral] -= bet.reservedProfit;

        bet.status = BetStatus.CANCELLED;
        bet.resolvedAt = block.timestamp;
        bet.won = false;

        if (isFreeBet[betId]) {
            bet.payout = 0;
            IERC20(bet.collateral).safeTransfer(freeBetsHolder, bet.amount);
            IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(bet.user, bet.collateral, bet.amount, bet.amount);
        } else {
            bet.payout = bet.amount;
            IERC20(bet.collateral).safeTransfer(bet.user, bet.amount);
        }

        emit BetCancelled(betId, bet.requestId, bet.user, bet.amount, adminCancelled);
    }

    /// @notice Requests one random word from Chainlink VRF
    /// @return requestId Chainlink VRF request id
    function _requestRandomWord() internal returns (uint requestId) {
        requestId = vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
    }

    /// @notice Checks whether available collateral balance covers all reserved profit
    /// @param collateral Collateral token address
    /// @return True if bankroll is sufficient for the collateral
    function _hasEnoughLiquidity(address collateral) internal view returns (bool) {
        return IERC20(collateral).balanceOf(address(this)) >= reservedProfitPerCollateral[collateral];
    }

    /// @notice Returns the normalized price for a supported collateral
    /// @param collateral Collateral token address
    /// @return Collateral price normalized to 18 decimals
    function _getCollateralPrice(address collateral) internal view returns (uint) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();

        if (collateral == usdc) {
            return ONE;
        }

        bytes32 currencyKey = priceFeedKeyPerCollateral[collateral];
        if (currencyKey == bytes32(0)) revert InvalidCollateral();

        uint price = priceFeed.rateForCurrency(currencyKey);
        if (price == 0) revert InvalidPrice();

        return price;
    }

    /// @notice Converts collateral amount into USD value normalized to 18 decimals
    /// @param collateral Collateral token address
    /// @param amount Collateral amount
    /// @return USD value normalized to 18 decimals
    function _getUsdValue(address collateral, uint amount) internal view returns (uint) {
        if (collateral == usdc) {
            return (amount * ONE) / USDC_UNIT;
        }

        uint price = _getCollateralPrice(collateral);
        return (amount * price) / ONE;
    }

    /// @notice Validates encoded target for a given bet type
    /// @param betType Dice bet type
    /// @param target Encoded target value
    function _validateTarget(BetType betType, uint8 target) internal pure {
        if (betType == BetType.ROLL_UNDER) {
            if (target < 2 || target > DICE_SIDES) revert InvalidTarget();
            return;
        }

        if (betType == BetType.ROLL_OVER) {
            if (target < 1 || target >= DICE_SIDES) revert InvalidTarget();
            return;
        }

        revert InvalidBetType();
    }

    /// @notice Returns the number of winning faces for a given dice target
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Number of winning faces
    function _getWinningFaces(BetType betType, uint8 target) internal pure returns (uint8) {
        if (betType == BetType.ROLL_UNDER) {
            return target - 1;
        }

        if (betType == BetType.ROLL_OVER) {
            return DICE_SIDES - target;
        }

        revert InvalidBetType();
    }

    /// @notice Returns win probability for a given dice target in 1e18 precision
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Probability normalized to 18 decimals
    function _getWinProbability(BetType betType, uint8 target) internal pure returns (uint) {
        uint8 winningFaces = _getWinningFaces(betType, target);
        return (uint(winningFaces) * ONE) / DICE_SIDES;
    }

    /// @notice Returns total payout multiplier for a given dice target in 1e18 precision
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Total payout multiplier including original stake
    function _getPayoutMultiplier(BetType betType, uint8 target) internal view returns (uint) {
        uint probability = _getWinProbability(betType, target);
        return ((ONE - houseEdge) * ONE) / probability;
    }

    /// @notice Returns reserved profit amount in collateral units for a winning bet
    /// @param amount Bet amount
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Reserved house-side profit liability
    function _getReservedProfit(uint amount, BetType betType, uint8 target) internal view returns (uint) {
        uint multiplier = _getPayoutMultiplier(betType, target);
        uint payout = (amount * multiplier) / ONE;
        return payout - amount;
    }

    /// @notice Returns whether a given bet target wins for a dice result
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @param result Dice result in range 1..20
    /// @return True if the bet wins
    function _isWinning(BetType betType, uint8 target, uint8 result) internal pure returns (bool) {
        if (betType == BetType.ROLL_UNDER) {
            return result < target;
        }

        if (betType == BetType.ROLL_OVER) {
            return result > target;
        }

        revert InvalidBetType();
    }

    /* ========== GETTERS ========== */

    /// @notice Returns number of winning faces for a given bet
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Number of winning faces
    function getWinningFaces(BetType betType, uint8 target) external pure returns (uint8) {
        _validateTarget(betType, target);
        return _getWinningFaces(betType, target);
    }

    /// @notice Returns win probability in 1e18 precision for a given bet
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Probability normalized to 18 decimals
    function getWinProbability(BetType betType, uint8 target) external pure returns (uint) {
        _validateTarget(betType, target);
        return _getWinProbability(betType, target);
    }

    /// @notice Returns total payout multiplier in 1e18 precision for a given bet
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Total payout multiplier including original stake
    function getPayoutMultiplier(BetType betType, uint8 target) external view returns (uint) {
        _validateTarget(betType, target);
        return _getPayoutMultiplier(betType, target);
    }

    /// @notice Returns potential profit in USD for a given bet
    /// @param collateral Collateral token address
    /// @param amount Bet amount
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Potential profit in USD normalized to 18 decimals
    function getPotentialProfit(
        address collateral,
        uint amount,
        BetType betType,
        uint8 target
    ) external view returns (uint) {
        _validateTarget(betType, target);
        uint reservedProfit = _getReservedProfit(amount, betType, target);
        return _getUsdValue(collateral, reservedProfit);
    }

    /// @notice Returns total payout in collateral units for a winning bet
    /// @param amount Bet amount
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @return Total payout including original stake
    function getPotentialPayoutCollateral(uint amount, BetType betType, uint8 target) external view returns (uint) {
        _validateTarget(betType, target);
        uint multiplier = _getPayoutMultiplier(betType, target);
        return (amount * multiplier) / ONE;
    }

    /// @notice Returns normalized collateral price
    /// @param collateral Collateral token address
    /// @return Collateral price normalized to 18 decimals
    function getCollateralPrice(address collateral) external view returns (uint) {
        return _getCollateralPrice(collateral);
    }

    /// @notice Returns whether a given target wins for a provided dice result
    /// @param betType Dice bet type
    /// @param target Encoded target value
    /// @param result Dice result in range 1..20
    /// @return True if the bet wins
    function isWinningBet(BetType betType, uint8 target, uint8 result) external pure returns (bool) {
        _validateTarget(betType, target);
        if (result < 1 || result > DICE_SIDES) revert InvalidResult();
        return _isWinning(betType, target, result);
    }

    /// @notice Returns currently available liquidity for a collateral after reserved profit
    /// @param collateral Collateral token address
    /// @return Available liquidity amount in collateral units
    function getAvailableLiquidity(address collateral) external view returns (uint) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint balance = IERC20(collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[collateral];
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Returns the number of bets placed by a user
    function getUserBetCount(address user) external view returns (uint) {
        return userBetIds[user].length;
    }

    /// @notice Returns core bet data
    function getBetBase(
        uint betId
    )
        external
        view
        returns (
            address user,
            address collateral,
            uint amount,
            uint payout,
            uint requestId,
            uint placedAt,
            uint resolvedAt,
            uint reservedProfit
        )
    {
        Bet storage b = bets[betId];
        return (b.user, b.collateral, b.amount, b.payout, b.requestId, b.placedAt, b.resolvedAt, b.reservedProfit);
    }

    /// @notice Returns bet game details
    function getBetDetails(
        uint betId
    ) external view returns (BetType betType, BetStatus status, uint8 target, uint8 result, bool won) {
        Bet storage b = bets[betId];
        return (b.betType, b.status, b.target, b.result, b.won);
    }

    /// @notice Returns bet IDs for a user's bets with pagination (reverse chronological)
    function getUserBetIds(address user, uint offset, uint limit) external view returns (uint[] memory ids) {
        uint[] storage allIds = userBetIds[user];
        uint len = allIds.length;
        if (offset >= len) return new uint[](0);
        uint remaining = len - offset;
        uint count = remaining < limit ? remaining : limit;
        ids = new uint[](count);
        for (uint i = 0; i < count; i++) {
            ids[i] = allIds[len - 1 - offset - i];
        }
    }

    /// @notice Returns recent bet IDs with pagination (reverse chronological)
    function getRecentBetIds(uint offset, uint limit) external view returns (uint[] memory ids) {
        uint latest = nextBetId - 1;
        if (offset >= latest) return new uint[](0);
        uint start = latest - offset;
        uint count = start < limit ? start : limit;
        ids = new uint[](count);
        for (uint i = 0; i < count; i++) {
            ids[i] = start - i;
        }
    }

    /* ========== SETTERS ========== */

    /// @notice Sets maximum allowed profit per bet in USD
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param _maxProfitUsd Maximum profit in USD normalized to 18 decimals
    function setMaxProfitUsd(uint _maxProfitUsd) external onlyRiskManager {
        if (_maxProfitUsd == 0) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        emit MaxProfitUsdChanged(_maxProfitUsd);
    }

    /// @notice Sets timeout after which pending bets can be cancelled
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param _cancelTimeout Timeout in seconds
    function setCancelTimeout(uint _cancelTimeout) external onlyRiskManager {
        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        cancelTimeout = _cancelTimeout;
        emit CancelTimeoutChanged(_cancelTimeout);
    }

    /// @notice Sets house edge
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param _houseEdge House edge in 1e18 precision
    function setHouseEdge(uint _houseEdge) external onlyRiskManager {
        if (_houseEdge == 0 || _houseEdge > MAX_HOUSE_EDGE) revert InvalidHouseEdge();
        houseEdge = _houseEdge;
        emit HouseEdgeChanged(_houseEdge);
    }

    /// @notice Adds or removes a supported collateral
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param collateral Collateral token address
    /// @param isSupported Whether the collateral is supported
    function setSupportedCollateral(address collateral, bool isSupported) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        supportedCollateral[collateral] = isSupported;
        emit SupportedCollateralChanged(collateral, isSupported);
    }

    /// @notice Sets price feed key for a collateral
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param collateral Collateral token address
    /// @param currencyKey Price feed currency key
    function setPriceFeedKeyPerCollateral(address collateral, bytes32 currencyKey) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        priceFeedKeyPerCollateral[collateral] = currencyKey;
        emit PriceFeedKeyPerCollateralChanged(collateral, currencyKey);
    }

    /// @notice Sets manager contract address
    /// @param _manager Manager contract address
    function setManager(address _manager) external onlyOwner {
        if (_manager == address(0)) revert InvalidAddress();
        manager = ISportsAMMV2Manager(_manager);
        emit ManagerChanged(_manager);
    }

    /// @notice Sets price feed contract address
    /// @param _priceFeed Price feed contract address
    function setPriceFeed(address _priceFeed) external onlyOwner {
        if (_priceFeed == address(0)) revert InvalidAddress();
        priceFeed = IPriceFeed(_priceFeed);
        emit PriceFeedChanged(_priceFeed);
    }

    /// @notice Sets Chainlink VRF coordinator address
    /// @param _vrfCoordinator Chainlink VRF coordinator address
    function setVrfCoordinator(address _vrfCoordinator) external onlyOwner {
        if (_vrfCoordinator == address(0)) revert InvalidAddress();
        vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        emit VrfCoordinatorChanged(_vrfCoordinator);
    }

    /// @notice Sets the free bets holder contract
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit FreeBetsHolderChanged(_freeBetsHolder);
    }

    /// @notice Sets the referrals contract
    function setReferrals(address _referrals) external onlyOwner {
        referrals = IReferrals(_referrals);
        emit ReferralsChanged(_referrals);
    }

    /// @notice Withdraws collateral from the contract bankroll
    /// @param _collateral The address of the ERC20 token to withdraw
    /// @param _recipient The address of the recipient, defaults to owner if zero address
    /// @param _amount The amount of tokens to withdraw
    function withdrawCollateral(address _collateral, address _recipient, uint _amount) external onlyOwner {
        uint balance = IERC20(_collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[_collateral];
        if (_amount > balance || balance - _amount < reserved) revert InsufficientAvailableLiquidity();
        address recipient = _recipient == address(0) ? owner : _recipient;
        IERC20(_collateral).safeTransfer(recipient, _amount);
        emit WithdrawnCollateral(_collateral, recipient, _amount);
    }

    /// @notice Sets Chainlink VRF configuration
    /// @param _subscriptionId Chainlink VRF subscription id
    /// @param _keyHash Chainlink VRF key hash / gas lane
    /// @param _callbackGasLimit Gas limit for callback
    /// @param _requestConfirmations Number of confirmations before VRF fulfillment
    /// @param _nativePayment Whether VRF uses native token payment
    function setVrfConfig(
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations,
        bool _nativePayment
    ) external onlyOwner {
        if (_callbackGasLimit == 0) revert InvalidAmount();

        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
        nativePayment = _nativePayment;

        emit VrfConfigChanged(_subscriptionId, _keyHash, _callbackGasLimit, _requestConfirmations, _nativePayment);
    }

    /* ========== MODIFIERS ========== */

    /// @notice Restricts access to owner or manager addresses whitelisted for risk management
    modifier onlyRiskManager() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.RISK_MANAGING)) {
            revert InvalidSender();
        }
        _;
    }

    /// @notice Restricts access to owner or manager addresses whitelisted for market resolving
    modifier onlyResolver() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING)) {
            revert InvalidSender();
        }
        _;
    }

    /// @notice Restricts access to owner or manager addresses whitelisted for pausing
    modifier onlyPauser() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.TICKET_PAUSER)) {
            revert InvalidSender();
        }
        _;
    }

    /* ========== EVENTS ========== */

    /// @notice Emitted when a new bet is placed
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param collateral Collateral token address
    /// @param amount Bet amount
    /// @param betType Dice bet type
    /// @param target Encoded target value
    event BetPlaced(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        address collateral,
        uint amount,
        BetType betType,
        uint8 target
    );

    /// @notice Emitted when a bet is resolved
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param result Dice result in range 1..20
    /// @param won Whether the bet won
    /// @param payout Final payout amount
    event BetResolved(uint indexed betId, uint indexed requestId, address indexed user, uint8 result, bool won, uint payout);

    /// @notice Emitted when a bet is cancelled
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param refundedAmount Refunded stake amount
    /// @param adminCancelled Whether the cancellation was admin-triggered
    event BetCancelled(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        uint refundedAmount,
        bool adminCancelled
    );

    /// @notice Emitted when maximum profit per bet is changed
    /// @param maxProfitUsd New maximum profit in USD normalized to 18 decimals
    event MaxProfitUsdChanged(uint maxProfitUsd);

    /// @notice Emitted when cancel timeout is changed
    /// @param cancelTimeout New timeout in seconds
    event CancelTimeoutChanged(uint cancelTimeout);

    /// @notice Emitted when house edge is changed
    /// @param houseEdge New house edge in 1e18 precision
    event HouseEdgeChanged(uint houseEdge);

    /// @notice Emitted when collateral support is changed
    /// @param collateral Collateral token address
    /// @param supported Whether the collateral is supported
    event SupportedCollateralChanged(address collateral, bool supported);

    /// @notice Emitted when price feed key for a collateral is changed
    /// @param collateral Collateral token address
    /// @param key New price feed key
    event PriceFeedKeyPerCollateralChanged(address collateral, bytes32 key);

    /// @notice Emitted when manager contract is changed
    /// @param manager New manager contract address
    event ManagerChanged(address manager);

    /// @notice Emitted when price feed contract is changed
    /// @param priceFeed New price feed contract address
    event PriceFeedChanged(address priceFeed);

    /// @notice Emitted when VRF coordinator is changed
    /// @param vrfCoordinator New Chainlink VRF coordinator address
    event VrfCoordinatorChanged(address vrfCoordinator);
    event FreeBetsHolderChanged(address freeBetsHolder);
    event ReferralsChanged(address referrals);
    event ReferrerPaid(address indexed referrer, address indexed user, uint amount, uint betAmount, address collateral);

    /// @notice Emitted when collateral is withdrawn from the bankroll
    /// @param collateral Collateral token address
    /// @param recipient Recipient address
    /// @param amount Amount withdrawn
    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint amount);

    /// @notice Emitted when VRF config is changed
    /// @param subscriptionId New Chainlink VRF subscription id
    /// @param keyHash New Chainlink VRF key hash
    /// @param callbackGasLimit New callback gas limit
    /// @param requestConfirmations New request confirmations value
    /// @param nativePayment Whether native payment is enabled
    event VrfConfigChanged(
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        bool nativePayment
    );
}
