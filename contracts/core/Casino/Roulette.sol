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

/// @title Roulette
/// @author Overtime
/// @notice American roulette contract using Chainlink VRF for single-player spins
/// @dev Supports USDC, WETH and OVER collateral, with bankroll reservation per collateral
contract Roulette is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant USDC_UNIT = 1e6;
    uint private constant WHEEL_SIZE = 37; // 0..36 single-zero (European)

    /// @notice Minimum allowed bet value expressed in USD, normalized to 18 decimals
    uint public constant MIN_BET_USD = 3e18;

    /// @notice Minimum allowed cancel timeout in seconds
    uint public constant MIN_CANCEL_TIMEOUT = 30;

    /// @notice Maximum number of picks (sub-selections) that can be combined in a single bet
    uint public constant MAX_PICKS_PER_BET = 10;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidCollateral();
    error InvalidPrice();
    error InvalidAmount();
    error InvalidBetType();
    error InvalidSelection();
    error BetNotFound();
    error BetNotPending();
    error BetNotOwner();
    error CancelTimeoutNotReached();
    error MaxProfitExceeded();
    error InsufficientAvailableLiquidity();
    error InvalidPickCount();

    /* ========== ENUMS ========== */

    /// @notice Supported roulette bet types for MVP
    enum BetType {
        STRAIGHT,
        RED_BLACK,
        ODD_EVEN,
        LOW_HIGH,
        DOZEN,
        COLUMN
    }

    /// @notice Lifecycle status of a roulette bet
    enum BetStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    /* ========== STRUCTS ========== */

    /// @notice Stored data for an individual roulette bet
    /// @param user Address of the bettor
    /// @param collateral Collateral token used for the bet
    /// @param amount Amount staked
    /// @param payout Final payout amount, 0 if lost, original amount if cancelled
    /// @param requestId Chainlink VRF request id
    /// @param placedAt Timestamp when the bet was placed
    /// @param resolvedAt Timestamp when the bet was resolved or cancelled
    /// @param reservedProfit Reserved house-side profit liability for this bet
    /// @param betType Type of roulette bet
    /// @param status Current status of the bet
    /// @param selection Encoded selection for the chosen bet type
    /// @param result Winning roulette result in range 0..36 (European single-zero)
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
        uint8 selection;
        uint8 result;
        bool won;
    }

    /// @notice User-provided input for one pick inside a bet
    /// @param betType Roulette bet type for this pick
    /// @param selection Encoded selection value for this pick
    /// @param amount Collateral amount staked on this pick
    struct PickInput {
        BetType betType;
        uint8 selection;
        uint amount;
    }

    /// @notice Stored per-pick data for a multi-pick bet (length == 0 for a single-pick bet — the
    /// pick's data lives on the parent Bet struct itself)
    struct Pick {
        BetType betType;
        uint8 selection;
        bool won;
        uint amount;
        uint reservedProfit;
        uint payout;
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

    // ---- Multi-pick storage (appended; must preserve proxy layout above) ----

    /// @notice Per-pick data for multi-pick bets. Empty for single-pick bets (the pick lives on Bet itself)
    mapping(uint => Pick[]) internal picks;

    /* ========== PUBLIC / EXTERNAL METHODS ========== */

    /// @notice Initializes the roulette contract
    /// @param core Core protocol addresses
    /// @param collateralConfig Collateral addresses and price feed keys
    /// @param _maxProfitUsd Maximum allowed profit per bet in USD, normalized to 18 decimals
    /// @param _cancelTimeout Timeout after which a pending bet can be cancelled
    /// @param vrfConfig Chainlink VRF configuration
    function initialize(
        CoreAddresses calldata core,
        CollateralConfig calldata collateralConfig,
        uint _maxProfitUsd,
        uint _cancelTimeout,
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

        subscriptionId = vrfConfig.subscriptionId;
        keyHash = vrfConfig.keyHash;
        callbackGasLimit = vrfConfig.callbackGasLimit;
        requestConfirmations = vrfConfig.requestConfirmations;
        nativePayment = vrfConfig.nativePayment;

        nextBetId = 1;
    }

    /// @notice Places a single-pick roulette bet and requests randomness from Chainlink VRF
    function placeBet(
        address collateral,
        uint amount,
        BetType betType,
        uint8 selection,
        address _referrer
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        _setReferrer(_referrer, msg.sender);
        return _placeSingle(msg.sender, collateral, amount, betType, selection, false);
    }

    /// @notice Places a single-pick roulette bet using free bet balance
    function placeBetWithFreeBet(
        address collateral,
        uint amount,
        BetType betType,
        uint8 selection
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, amount);
        return _placeSingle(msg.sender, collateral, amount, betType, selection, true);
    }

    /// @notice Places a multi-pick bet with up to MAX_PICKS_PER_BET picks sharing one VRF request
    /// @dev All picks share the same collateral. Per-pick amounts may differ. Aggregate profit across
    /// picks is validated against maxProfitUsd, and aggregate stake must satisfy MIN_BET_USD.
    /// Duplicate picks are permitted. With a single pick, this behaves identically to placeBet
    /// @return betId The id of the new bet
    /// @return requestId The Chainlink VRF request id
    function placeMultiBet(
        address collateral,
        PickInput[] calldata pickInputs,
        address _referrer
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint totalAmount = _validateAndSum(pickInputs);
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), totalAmount);
        _setReferrer(_referrer, msg.sender);
        return _placeMulti(msg.sender, collateral, pickInputs, totalAmount, false);
    }

    /// @notice Places a multi-pick bet using free bet balance
    function placeMultiBetWithFreeBet(
        address collateral,
        PickInput[] calldata pickInputs
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint totalAmount = _validateAndSum(pickInputs);
        IFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, totalAmount);
        return _placeMulti(msg.sender, collateral, pickInputs, totalAmount, true);
    }

    function _validateAndSum(PickInput[] calldata pickInputs) internal pure returns (uint total) {
        uint n = pickInputs.length;
        if (n == 0 || n > MAX_PICKS_PER_BET) revert InvalidPickCount();
        for (uint i = 0; i < n; i++) {
            total += pickInputs[i].amount;
        }
    }

    function _placeSingle(
        address user,
        address collateral,
        uint amount,
        BetType betType,
        uint8 selection,
        bool _isFreeBet
    ) internal returns (uint betId, uint requestId) {
        if (amount == 0) revert InvalidAmount();
        _validateSelection(betType, selection);

        if (_getUsdValue(collateral, amount) < MIN_BET_USD) revert InvalidAmount();

        uint profit = amount * _getProfitMultiplier(betType);
        if (_getUsdValue(collateral, profit) > maxProfitUsd) revert MaxProfitExceeded();

        reservedProfitPerCollateral[collateral] += profit;
        if (!_hasEnoughLiquidity(collateral)) {
            reservedProfitPerCollateral[collateral] -= profit;
            revert InsufficientAvailableLiquidity();
        }

        requestId = _requestRandomWord();
        betId = nextBetId++;
        bets[betId] = Bet({
            user: user,
            collateral: collateral,
            amount: amount,
            payout: 0,
            requestId: requestId,
            placedAt: block.timestamp,
            resolvedAt: 0,
            reservedProfit: profit,
            betType: betType,
            status: BetStatus.PENDING,
            selection: selection,
            result: 0,
            won: false
        });
        if (_isFreeBet) isFreeBet[betId] = true;
        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        emit BetPlaced(betId, requestId, user, collateral, amount, betType, selection);
    }

    function _placeMulti(
        address user,
        address collateral,
        PickInput[] calldata pickInputs,
        uint totalAmount,
        bool _isFreeBet
    ) internal returns (uint betId, uint requestId) {
        uint n = pickInputs.length;
        uint totalReservedProfit;
        for (uint i = 0; i < n; i++) {
            PickInput calldata p = pickInputs[i];
            if (p.amount == 0) revert InvalidAmount();
            _validateSelection(p.betType, p.selection);
            totalReservedProfit += p.amount * _getProfitMultiplier(p.betType);
        }

        if (_getUsdValue(collateral, totalAmount) < MIN_BET_USD) revert InvalidAmount();
        if (_getUsdValue(collateral, totalReservedProfit) > maxProfitUsd) revert MaxProfitExceeded();

        reservedProfitPerCollateral[collateral] += totalReservedProfit;
        if (!_hasEnoughLiquidity(collateral)) {
            reservedProfitPerCollateral[collateral] -= totalReservedProfit;
            revert InsufficientAvailableLiquidity();
        }

        requestId = _requestRandomWord();
        betId = nextBetId++;

        // For multi-pick bets, Bet.betType/selection reflect pick 0 as "primary" for UIs; the full
        // pick list lives in picks[betId]. Bet.amount / reservedProfit / payout are aggregates.
        bets[betId] = Bet({
            user: user,
            collateral: collateral,
            amount: totalAmount,
            payout: 0,
            requestId: requestId,
            placedAt: block.timestamp,
            resolvedAt: 0,
            reservedProfit: totalReservedProfit,
            betType: pickInputs[0].betType,
            status: BetStatus.PENDING,
            selection: pickInputs[0].selection,
            result: 0,
            won: false
        });
        if (_isFreeBet) isFreeBet[betId] = true;
        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        Pick[] storage dst = picks[betId];
        for (uint i = 0; i < n; i++) {
            PickInput calldata p = pickInputs[i];
            dst.push(
                Pick({
                    betType: p.betType,
                    selection: p.selection,
                    won: false,
                    amount: p.amount,
                    reservedProfit: p.amount * _getProfitMultiplier(p.betType),
                    payout: 0
                })
            );
        }

        emit BetPlaced(betId, requestId, user, collateral, totalAmount, pickInputs[0].betType, pickInputs[0].selection);
        emit MultiBetPlaced(betId, requestId, user, collateral, totalAmount, uint8(n), _isFreeBet);
    }

    /// @notice Cancels a pending bet after timeout and refunds the aggregate stake
    /// @param betId Bet id to cancel
    function cancelBet(uint betId) external nonReentrant {
        Bet storage bet = bets[betId];

        if (bet.status == BetStatus.NONE) revert BetNotFound();
        if (bet.user != msg.sender) revert BetNotOwner();
        if (bet.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < bet.placedAt + cancelTimeout) revert CancelTimeoutNotReached();

        _cancelBet(betId, false);
    }

    /// @notice Emergency cancels a pending bet and refunds the aggregate stake
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

    /// @notice Internal roulette resolution logic after VRF fulfillment
    /// @dev Single code path handles both single-pick and multi-pick bets: when picks[betId] is empty
    /// the Bet struct itself describes the only pick; otherwise iterate the stored Pick array
    /// @param requestId Chainlink VRF request id
    /// @param randomWords Array of VRF random words
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal {
        uint betId = requestIdToBetId[requestId];
        if (betId == 0) return;

        Bet storage bet = bets[betId];
        if (bet.status != BetStatus.PENDING) return;

        uint8 result = uint8(randomWords[0] % WHEEL_SIZE);
        address collateral = bet.collateral;
        address user = bet.user;

        reservedProfitPerCollateral[collateral] -= bet.reservedProfit;

        uint totalPayout;
        bool anyWon;
        Pick[] storage betPicks = picks[betId];
        uint pickCount = betPicks.length;
        if (pickCount == 0) {
            bool won = _isWinning(bet.betType, bet.selection, result);
            if (won) {
                totalPayout = bet.amount + bet.reservedProfit;
                anyWon = true;
            }
        } else {
            for (uint i = 0; i < pickCount; i++) {
                Pick storage p = betPicks[i];
                bool won = _isWinning(p.betType, p.selection, result);
                uint legPayout = 0;
                if (won) {
                    legPayout = p.amount + p.reservedProfit;
                    totalPayout += legPayout;
                    anyWon = true;
                }
                p.won = won;
                p.payout = legPayout;
            }
        }

        if (totalPayout > 0) {
            if (isFreeBet[betId]) {
                IERC20(collateral).safeTransfer(freeBetsHolder, totalPayout);
                IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(user, collateral, totalPayout, bet.amount);
            } else {
                IERC20(collateral).safeTransfer(user, totalPayout);
            }
        } else {
            _payReferrer(user, collateral, bet.amount);
        }

        bet.result = result;
        bet.won = anyWon;
        bet.payout = totalPayout;
        bet.status = BetStatus.RESOLVED;
        bet.resolvedAt = block.timestamp;

        emit BetResolved(betId, requestId, user, result, anyWon, totalPayout);
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

    /// @notice Returns profit multiplier for a given roulette bet type
    /// @param betType Roulette bet type
    /// @return Profit multiplier excluding original stake
    function _getProfitMultiplier(BetType betType) internal pure returns (uint) {
        if (betType == BetType.STRAIGHT) return 35;

        if (betType == BetType.RED_BLACK || betType == BetType.ODD_EVEN || betType == BetType.LOW_HIGH) {
            return 1;
        }

        if (betType == BetType.DOZEN || betType == BetType.COLUMN) {
            return 2;
        }

        revert InvalidBetType();
    }

    /// @notice Validates encoded selection for a given bet type
    /// @param betType Roulette bet type
    /// @param selection Encoded selection value
    function _validateSelection(BetType betType, uint8 selection) internal pure {
        if (betType == BetType.STRAIGHT) {
            if (selection > 36) revert InvalidSelection();
            return;
        }

        if (betType == BetType.RED_BLACK || betType == BetType.ODD_EVEN || betType == BetType.LOW_HIGH) {
            if (selection > 1) revert InvalidSelection();
            return;
        }

        if (betType == BetType.DOZEN || betType == BetType.COLUMN) {
            if (selection > 2) revert InvalidSelection();
            return;
        }

        revert InvalidBetType();
    }

    /// @notice Returns whether a given bet selection wins for a roulette result
    /// @param betType Roulette bet type
    /// @param selection Encoded selection value
    /// @param result Roulette result in range 0..36 (European single-zero)
    /// @return True if the bet wins
    function _isWinning(BetType betType, uint8 selection, uint8 result) internal pure returns (bool) {
        if (betType == BetType.STRAIGHT) {
            return result == selection;
        }

        if (result == 0) {
            return false;
        }

        if (betType == BetType.RED_BLACK) {
            bool isRed = _isRed(result);
            return (selection == 0 && isRed) || (selection == 1 && !isRed);
        }

        if (betType == BetType.ODD_EVEN) {
            bool isEven = result % 2 == 0;
            return (selection == 0 && !isEven) || (selection == 1 && isEven);
        }

        if (betType == BetType.LOW_HIGH) {
            return (selection == 0 && result >= 1 && result <= 18) || (selection == 1 && result >= 19 && result <= 36);
        }

        if (betType == BetType.DOZEN) {
            return
                (selection == 0 && result >= 1 && result <= 12) ||
                (selection == 1 && result >= 13 && result <= 24) ||
                (selection == 2 && result >= 25 && result <= 36);
        }

        if (betType == BetType.COLUMN) {
            uint8 column = uint8((result - 1) % 3);
            return selection == column;
        }

        revert InvalidBetType();
    }

    /// @notice Returns whether a roulette number is red
    /// @param n Roulette number in range 1..36
    /// @return True if the number is red
    function _isRed(uint8 n) internal pure returns (bool) {
        return
            n == 1 ||
            n == 3 ||
            n == 5 ||
            n == 7 ||
            n == 9 ||
            n == 12 ||
            n == 14 ||
            n == 16 ||
            n == 18 ||
            n == 19 ||
            n == 21 ||
            n == 23 ||
            n == 25 ||
            n == 27 ||
            n == 30 ||
            n == 32 ||
            n == 34 ||
            n == 36;
    }

    /* ========== GETTERS ========== */

    /// @notice Returns potential profit in USD for a given bet
    /// @param collateral Collateral token address
    /// @param amount Bet amount
    /// @param betType Roulette bet type
    /// @return Potential profit in USD normalized to 18 decimals
    function getPotentialProfit(address collateral, uint amount, BetType betType) external view returns (uint) {
        uint potentialProfitCollateral = amount * _getProfitMultiplier(betType);
        return _getUsdValue(collateral, potentialProfitCollateral);
    }

    /// @notice Returns total payout in collateral units for a winning bet
    /// @param amount Bet amount
    /// @param betType Roulette bet type
    /// @return Total payout including original stake
    function getPotentialPayoutCollateral(uint amount, BetType betType) external pure returns (uint) {
        return amount + (amount * _getProfitMultiplier(betType));
    }

    /// @notice Returns normalized collateral price
    /// @param collateral Collateral token address
    /// @return Collateral price normalized to 18 decimals
    function getCollateralPrice(address collateral) external view returns (uint) {
        return _getCollateralPrice(collateral);
    }

    /// @notice Returns whether a given selection wins for a provided roulette result
    /// @param betType Roulette bet type
    /// @param selection Encoded selection value
    /// @param result Roulette result in range 0..36 (European single-zero)
    /// @return True if the bet wins
    function isWinningBet(BetType betType, uint8 selection, uint8 result) external pure returns (bool) {
        return _isWinning(betType, selection, result);
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

    /// @notice Returns bet game details including the full list of picks
    /// @dev For a single-pick bet, synthesizes a 1-element Pick array from the Bet struct; for a
    /// multi-pick bet, returns the stored picks. `won` is true iff any pick paid out (payout > 0)
    function getBetDetails(
        uint betId
    ) external view returns (Pick[] memory betPicks, BetStatus status, uint8 result, bool won) {
        Bet storage b = bets[betId];
        status = b.status;
        result = b.result;
        won = b.won;
        Pick[] storage stored = picks[betId];
        uint n = stored.length;
        if (n == 0) {
            betPicks = new Pick[](1);
            betPicks[0] = Pick({
                betType: b.betType,
                selection: b.selection,
                won: b.won,
                amount: b.amount,
                reservedProfit: b.reservedProfit,
                payout: b.payout
            });
        } else {
            betPicks = new Pick[](n);
            for (uint i = 0; i < n; i++) {
                betPicks[i] = stored[i];
            }
        }
    }

    /// @notice Returns the number of picks in a bet (always ≥ 1). Single-pick bets report 1
    function getBetPickCount(uint betId) external view returns (uint) {
        uint n = picks[betId].length;
        return n == 0 ? 1 : n;
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

    /// @notice Quotes aggregate stake and profit for a proposed multi-pick bet
    /// @dev Pure-of-state helper for UIs. The caller compares totalProfitUsd against maxProfitUsd and
    /// totalProfitCollateral against getAvailableLiquidity to check acceptability
    /// @return totalAmount Sum of per-pick stakes
    /// @return totalProfitCollateral Sum of per-pick profit, in collateral units
    /// @return totalProfitUsd Sum of per-pick profit, in USD normalized to 18 decimals
    function quoteMultiBet(
        address collateral,
        PickInput[] calldata pickInputs
    ) external view returns (uint totalAmount, uint totalProfitCollateral, uint totalProfitUsd) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint n = pickInputs.length;
        if (n == 0 || n > MAX_PICKS_PER_BET) revert InvalidPickCount();
        for (uint i = 0; i < n; i++) {
            _validateSelection(pickInputs[i].betType, pickInputs[i].selection);
            totalAmount += pickInputs[i].amount;
            totalProfitCollateral += pickInputs[i].amount * _getProfitMultiplier(pickInputs[i].betType);
        }
        totalProfitUsd = _getUsdValue(collateral, totalProfitCollateral);
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
    /// @param betType Roulette bet type
    /// @param selection Encoded selection value
    event BetPlaced(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        address collateral,
        uint amount,
        BetType betType,
        uint8 selection
    );

    /// @notice Emitted when a bet is resolved
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param result Roulette result in range 0..36 (European single-zero)
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

    /// @notice Emitted alongside BetPlaced when a bet includes multiple picks
    /// @dev For single-pick bets, only BetPlaced is emitted. For multi-pick bets, read picks[betId]
    /// or getBetDetails(betId) to retrieve the full pick list
    event MultiBetPlaced(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        address collateral,
        uint totalAmount,
        uint8 pickCount,
        bool isFreeBet
    );

    /// @notice Emitted when maximum profit per bet is changed
    /// @param maxProfitUsd New maximum profit in USD normalized to 18 decimals
    event MaxProfitUsdChanged(uint maxProfitUsd);

    /// @notice Emitted when cancel timeout is changed
    /// @param cancelTimeout New timeout in seconds
    event CancelTimeoutChanged(uint cancelTimeout);

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
