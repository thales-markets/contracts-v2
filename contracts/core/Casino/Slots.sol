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

/// @title Slots
/// @author Overtime
/// @notice 3-reel slot machine contract using Chainlink VRF
/// @dev Supports USDC, WETH and OVER collateral, with bankroll reservation per collateral
contract Slots is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant USDC_UNIT = 1e6;
    uint8 public constant REELS = 3;

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
    error InvalidConfig();
    error InvalidHouseEdge();
    error SpinNotFound();
    error SpinNotPending();
    error SpinNotOwner();
    error CancelTimeoutNotReached();
    error MaxProfitExceeded();
    error InsufficientAvailableLiquidity();

    /* ========== ENUMS ========== */

    /// @notice Lifecycle status of a slot spin
    enum SpinStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    /* ========== STRUCTS ========== */

    /// @notice Stored data for an individual slot spin
    struct Spin {
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint requestId;
        uint placedAt;
        uint resolvedAt;
        uint reservedProfit;
        SpinStatus status;
        uint8[3] reels;
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

    /// @notice Maximum allowed profit per spin in USD, normalized to 18 decimals
    uint public maxProfitUsd;

    /// @notice Timeout after which a pending spin can be cancelled
    uint public cancelTimeout;

    /// @notice House edge in 1e18 precision. Example: 1e16 = 1%
    uint public houseEdge;

    /// @notice Next spin id to assign
    uint public nextSpinId;

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

    /// @notice Stored spins by spin id
    mapping(uint => Spin) internal spins;

    /// @notice Maps VRF request id to spin id
    mapping(uint => uint) public requestIdToSpinId;

    /// @notice Tracks reserved house-side profit liability for all pending spins per collateral
    mapping(address => uint) public reservedProfitPerCollateral;

    /* ========== SLOT CONFIG ========== */

    /// @notice Number of distinct symbols on the reels
    uint8 public symbolCount;

    /// @notice Weights for each symbol (sum defines the distribution)
    uint[] public symbolWeights;

    /// @notice Payout multiplier for 3-of-a-kind per symbol (in 1e18 precision, net of stake)
    mapping(uint8 => uint) public triplePayout;

    /// @notice Maximum payout multiplier (used to calculate reserved profit)
    uint public maxPayoutMultiplier;

    /// @notice Spin IDs per user for history queries
    mapping(address => uint[]) private userSpinIds;

    /// @notice Free bets holder contract address
    address public freeBetsHolder;

    /// @notice Whether a spin was placed with a free bet
    mapping(uint => bool) public isFreeBet;

    /// @notice Referrals contract
    IReferrals public referrals;

    /// @notice Payout multiplier for adjacent 2-of-a-kind per symbol (in 1e18 precision, net of stake)
    /// @dev A pair is first-two-reels or last-two-reels matching (triples are handled separately)
    mapping(uint8 => uint) public pairPayout;

    /// @notice Cached sum of symbolWeights — updated in setSymbols to avoid recomputing per-reel
    uint public symbolWeightsTotal;

    /* ========== PUBLIC / EXTERNAL METHODS ========== */

    /// @notice Initializes the slots contract
    /// @param core Core protocol addresses
    /// @param collateralConfig Collateral addresses and price feed keys
    /// @param _maxProfitUsd Maximum allowed profit per spin in USD, normalized to 18 decimals
    /// @param _cancelTimeout Timeout after which a pending spin can be cancelled
    /// @param _houseEdge House edge in 1e18 precision. Example: 1e16 = 1%
    /// @param _maxPayoutMultiplier Maximum payout multiplier in 1e18 precision
    /// @param vrfConfig Chainlink VRF configuration
    function initialize(
        CoreAddresses calldata core,
        CollateralConfig calldata collateralConfig,
        uint _maxProfitUsd,
        uint _cancelTimeout,
        uint _houseEdge,
        uint _maxPayoutMultiplier,
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
        if (_maxPayoutMultiplier == 0) revert InvalidAmount();
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
        maxPayoutMultiplier = _maxPayoutMultiplier;

        subscriptionId = vrfConfig.subscriptionId;
        keyHash = vrfConfig.keyHash;
        callbackGasLimit = vrfConfig.callbackGasLimit;
        requestConfirmations = vrfConfig.requestConfirmations;
        nativePayment = vrfConfig.nativePayment;

        nextSpinId = 1;
    }

    /// @notice Places a slot spin and requests randomness from Chainlink VRF
    /// @param collateral Collateral token address
    /// @param amount Amount of collateral to stake
    /// @return spinId Newly created spin id
    /// @return requestId Chainlink VRF request id
    function spin(
        address collateral,
        uint amount,
        address _referrer
    ) external nonReentrant notPaused returns (uint spinId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        _setReferrer(_referrer, msg.sender);
        return _spin(msg.sender, collateral, amount, false);
    }

    /// @notice Places a slot spin using free bet balance
    /// @param collateral Collateral token address
    /// @param amount Amount of collateral to stake
    /// @return spinId Newly created spin id
    /// @return requestId Chainlink VRF request id
    function spinWithFreeBet(
        address collateral,
        uint amount
    ) external nonReentrant notPaused returns (uint spinId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, amount);
        return _spin(msg.sender, collateral, amount, true);
    }

    function _spin(
        address user,
        address collateral,
        uint amount,
        bool _isFreeBet
    ) internal returns (uint spinId, uint requestId) {
        if (symbolCount == 0) revert InvalidConfig();
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        if (amount == 0) revert InvalidAmount();

        uint amountUsd = _getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        uint reservedProfit = (amount * maxPayoutMultiplier) / ONE;
        uint potentialProfitUsd = _getUsdValue(collateral, reservedProfit);

        if (potentialProfitUsd > maxProfitUsd) revert MaxProfitExceeded();

        reservedProfitPerCollateral[collateral] += amount + reservedProfit;

        if (!_hasEnoughLiquidity(collateral)) {
            reservedProfitPerCollateral[collateral] -= amount + reservedProfit;
            revert InsufficientAvailableLiquidity();
        }

        requestId = _requestRandomWord();

        spinId = nextSpinId++;
        spins[spinId] = Spin({
            user: user,
            collateral: collateral,
            amount: amount,
            payout: 0,
            requestId: requestId,
            placedAt: block.timestamp,
            resolvedAt: 0,
            reservedProfit: reservedProfit,
            status: SpinStatus.PENDING,
            reels: [uint8(0), uint8(0), uint8(0)],
            won: false
        });

        if (_isFreeBet) isFreeBet[spinId] = true;

        requestIdToSpinId[requestId] = spinId;
        userSpinIds[user].push(spinId);

        emit SpinPlaced(spinId, requestId, user, collateral, amount);
    }

    /// @notice Cancels a pending spin after timeout and refunds the original stake
    /// @param spinId Spin id to cancel
    function cancelSpin(uint spinId) external nonReentrant {
        Spin storage s = spins[spinId];

        if (s.status == SpinStatus.NONE) revert SpinNotFound();
        if (s.user != msg.sender) revert SpinNotOwner();
        if (s.status != SpinStatus.PENDING) revert SpinNotPending();
        if (block.timestamp < s.placedAt + cancelTimeout) revert CancelTimeoutNotReached();

        _cancelSpin(spinId, false);
    }

    /// @notice Emergency cancels a pending spin and refunds the original stake
    /// @dev Callable by owner or manager role with MARKET_RESOLVING permission
    /// @param spinId Spin id to cancel
    function adminCancelSpin(uint spinId) external onlyResolver nonReentrant {
        Spin storage s = spins[spinId];

        if (s.status == SpinStatus.NONE) revert SpinNotFound();
        if (s.status != SpinStatus.PENDING) revert SpinNotPending();

        _cancelSpin(spinId, true);
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

    /// @notice Internal spin resolution logic after VRF fulfillment
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal {
        uint spinId = requestIdToSpinId[requestId];
        if (spinId == 0) return;

        Spin storage s = spins[spinId];
        if (s.status != SpinStatus.PENDING) return;

        uint r = randomWords[0];

        uint8 r1 = _roll(uint256(keccak256(abi.encode(r, uint(0)))));
        uint8 r2 = _roll(uint256(keccak256(abi.encode(r, uint(1)))));
        uint8 r3 = _roll(uint256(keccak256(abi.encode(r, uint(2)))));

        s.reels = [r1, r2, r3];

        uint multiplier = _getPayoutMultiplier(r1, r2, r3);

        reservedProfitPerCollateral[s.collateral] -= s.amount + s.reservedProfit;

        uint payout = multiplier > 0 ? s.amount + (s.amount * multiplier) / ONE : 0;

        // State update before external transfers (CEI)
        s.payout = payout;
        s.won = multiplier > 0;
        s.status = SpinStatus.RESOLVED;
        s.resolvedAt = block.timestamp;

        emit SpinResolved(spinId, requestId, s.user, [r1, r2, r3], s.won, payout);

        if (multiplier > 0) {
            if (isFreeBet[spinId]) {
                IERC20(s.collateral).safeTransfer(freeBetsHolder, payout);
                IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(s.user, s.collateral, payout, s.amount);
            } else {
                IERC20(s.collateral).safeTransfer(s.user, payout);
            }
        } else if (!isFreeBet[spinId]) {
            _payReferrer(s.user, s.collateral, s.amount);
        }
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

    function _cancelSpin(uint spinId, bool adminCancelled) internal {
        Spin storage s = spins[spinId];

        reservedProfitPerCollateral[s.collateral] -= s.amount + s.reservedProfit;

        s.status = SpinStatus.CANCELLED;
        s.resolvedAt = block.timestamp;
        s.won = false;

        if (isFreeBet[spinId]) {
            s.payout = 0;
            IERC20(s.collateral).safeTransfer(freeBetsHolder, s.amount);
            IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(s.user, s.collateral, s.amount, s.amount);
        } else {
            s.payout = s.amount;
            IERC20(s.collateral).safeTransfer(s.user, s.amount);
        }

        emit SpinCancelled(spinId, s.requestId, s.user, s.amount, adminCancelled);
    }

    /// @notice Rolls a single reel using weighted random selection
    function _roll(uint r) internal view returns (uint8) {
        uint total = symbolWeightsTotal;
        if (total == 0) {
            // Fallback for the one-time upgrade window before setSymbols is re-called
            for (uint i = 0; i < symbolWeights.length; i++) total += symbolWeights[i];
        }
        uint rand = r % total;

        uint acc;
        for (uint8 i = 0; i < symbolCount; i++) {
            acc += symbolWeights[i];
            if (rand < acc) return i;
        }

        return 0;
    }

    /// @notice Returns the net payout multiplier in 1e18 precision for a given reel result
    /// @dev Triple (3-of-a-kind) supersedes adjacent pair. Pair matches `a==b` or `b==c`.
    ///      Returns 0 if no winning combination; applies house edge to the selected raw payout.
    function _getPayoutMultiplier(uint8 a, uint8 b, uint8 c) internal view returns (uint) {
        uint rawMultiplier;
        if (a == b && b == c) {
            rawMultiplier = triplePayout[a];
        } else if (a == b) {
            rawMultiplier = pairPayout[a];
        } else if (b == c) {
            rawMultiplier = pairPayout[b];
        }
        if (rawMultiplier == 0) return 0;
        return (rawMultiplier * (ONE - houseEdge)) / ONE;
    }

    /// @notice Requests one random word from Chainlink VRF
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
    function _hasEnoughLiquidity(address collateral) internal view returns (bool) {
        return IERC20(collateral).balanceOf(address(this)) >= reservedProfitPerCollateral[collateral];
    }

    /// @notice Returns the normalized price for a supported collateral
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
    function _getUsdValue(address collateral, uint amount) internal view returns (uint) {
        if (collateral == usdc) {
            return (amount * ONE) / USDC_UNIT;
        }

        uint price = _getCollateralPrice(collateral);
        return (amount * price) / ONE;
    }

    /* ========== GETTERS ========== */

    /// @notice Returns normalized collateral price
    function getCollateralPrice(address collateral) external view returns (uint) {
        return _getCollateralPrice(collateral);
    }

    /// @notice Returns currently available liquidity for a collateral after reserved profit
    function getAvailableLiquidity(address collateral) external view returns (uint) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint balance = IERC20(collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[collateral];
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Returns the reel results for a resolved spin
    /// @param spinId The ID of the spin
    /// @return The 3 reel symbol indices
    function getSpinReels(uint spinId) external view returns (uint8[3] memory) {
        return spins[spinId].reels;
    }

    /// @notice Returns the symbol weights array
    function getSymbolWeights() external view returns (uint[] memory) {
        return symbolWeights;
    }

    /// @notice Returns core spin data
    function getSpinBase(
        uint spinId
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
        Spin storage s = spins[spinId];
        return (s.user, s.collateral, s.amount, s.payout, s.requestId, s.placedAt, s.resolvedAt, s.reservedProfit);
    }

    /// @notice Returns spin game details
    function getSpinDetails(uint spinId) external view returns (SpinStatus status, uint8[3] memory reels, bool won) {
        Spin storage s = spins[spinId];
        return (s.status, s.reels, s.won);
    }

    /// @notice Returns the number of spins placed by a user
    function getUserSpinCount(address user) external view returns (uint) {
        return userSpinIds[user].length;
    }

    /// @notice Returns spin IDs for a user's spins with pagination (reverse chronological)
    function getUserSpinIds(address user, uint offset, uint limit) external view returns (uint[] memory ids) {
        uint[] storage allIds = userSpinIds[user];
        uint len = allIds.length;
        if (offset >= len) return new uint[](0);
        uint remaining = len - offset;
        uint count = remaining < limit ? remaining : limit;
        ids = new uint[](count);
        for (uint i = 0; i < count; i++) {
            ids[i] = allIds[len - 1 - offset - i];
        }
    }

    /// @notice Returns recent spin IDs with pagination (reverse chronological)
    function getRecentSpinIds(uint offset, uint limit) external view returns (uint[] memory ids) {
        uint latest = nextSpinId - 1;
        if (offset >= latest) return new uint[](0);
        uint start = latest - offset;
        uint count = start < limit ? start : limit;
        ids = new uint[](count);
        for (uint i = 0; i < count; i++) {
            ids[i] = start - i;
        }
    }

    /* ========== SETTERS ========== */

    /// @notice Sets the symbol configuration
    /// @param _count Number of distinct symbols
    /// @param weights Array of weights for each symbol
    function setSymbols(uint8 _count, uint[] calldata weights) external onlyOwner {
        if (_count == 0 || weights.length != _count) revert InvalidConfig();
        uint total;
        for (uint i = 0; i < weights.length; i++) total += weights[i];
        if (total == 0) revert InvalidConfig();
        symbolCount = _count;
        symbolWeights = weights;
        symbolWeightsTotal = total;
        emit SymbolsChanged(_count, weights);
    }

    /// @notice Sets the payout multiplier for a 3-of-a-kind symbol
    /// @param symbol Symbol index
    /// @param multiplier Payout multiplier in 1e18 precision (net of stake), must be <= maxPayoutMultiplier
    function setTriplePayout(uint8 symbol, uint multiplier) external onlyOwner {
        if (symbol >= symbolCount) revert InvalidConfig();
        if (multiplier > maxPayoutMultiplier) revert InvalidConfig();
        triplePayout[symbol] = multiplier;
        emit TriplePayoutChanged(symbol, multiplier);
    }

    /// @notice Sets the payout multiplier for an adjacent 2-of-a-kind symbol
    /// @param symbol Symbol index
    /// @param multiplier Payout multiplier in 1e18 precision (net of stake), must be <= maxPayoutMultiplier
    function setPairPayout(uint8 symbol, uint multiplier) external onlyOwner {
        if (symbol >= symbolCount) revert InvalidConfig();
        if (multiplier > maxPayoutMultiplier) revert InvalidConfig();
        pairPayout[symbol] = multiplier;
        emit PairPayoutChanged(symbol, multiplier);
    }

    /// @notice Sets maximum allowed profit per spin in USD
    function setMaxProfitUsd(uint _maxProfitUsd) external onlyRiskManager {
        if (_maxProfitUsd == 0) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        emit MaxProfitUsdChanged(_maxProfitUsd);
    }

    /// @notice Sets timeout after which pending spins can be cancelled
    function setCancelTimeout(uint _cancelTimeout) external onlyRiskManager {
        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        cancelTimeout = _cancelTimeout;
        emit CancelTimeoutChanged(_cancelTimeout);
    }

    /// @notice Sets house edge
    function setHouseEdge(uint _houseEdge) external onlyRiskManager {
        if (_houseEdge == 0 || _houseEdge > MAX_HOUSE_EDGE) revert InvalidHouseEdge();
        houseEdge = _houseEdge;
        emit HouseEdgeChanged(_houseEdge);
    }

    /// @notice Sets maximum payout multiplier (must be >= all existing triplePayout and pairPayout values)
    function setMaxPayoutMultiplier(uint _maxPayoutMultiplier) external onlyRiskManager {
        if (_maxPayoutMultiplier == 0) revert InvalidAmount();
        for (uint8 i = 0; i < symbolCount; i++) {
            if (triplePayout[i] > _maxPayoutMultiplier) revert InvalidConfig();
            if (pairPayout[i] > _maxPayoutMultiplier) revert InvalidConfig();
        }
        maxPayoutMultiplier = _maxPayoutMultiplier;
        emit MaxPayoutMultiplierChanged(_maxPayoutMultiplier);
    }

    /// @notice Adds or removes a supported collateral
    function setSupportedCollateral(address collateral, bool isSupported) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        supportedCollateral[collateral] = isSupported;
        emit SupportedCollateralChanged(collateral, isSupported);
    }

    /// @notice Sets price feed key for a collateral
    function setPriceFeedKeyPerCollateral(address collateral, bytes32 currencyKey) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        priceFeedKeyPerCollateral[collateral] = currencyKey;
        emit PriceFeedKeyPerCollateralChanged(collateral, currencyKey);
    }

    /// @notice Sets manager contract address
    function setManager(address _manager) external onlyOwner {
        if (_manager == address(0)) revert InvalidAddress();
        manager = ISportsAMMV2Manager(_manager);
        emit ManagerChanged(_manager);
    }

    /// @notice Sets price feed contract address
    function setPriceFeed(address _priceFeed) external onlyOwner {
        if (_priceFeed == address(0)) revert InvalidAddress();
        priceFeed = IPriceFeed(_priceFeed);
        emit PriceFeedChanged(_priceFeed);
    }

    /// @notice Sets Chainlink VRF coordinator address
    function setVrfCoordinator(address _vrfCoordinator) external onlyOwner {
        if (_vrfCoordinator == address(0)) revert InvalidAddress();
        vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        emit VrfCoordinatorChanged(_vrfCoordinator);
    }

    /// @notice Sets the free bets holder contract
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        if (_freeBetsHolder == address(0)) revert InvalidAddress();
        freeBetsHolder = _freeBetsHolder;
        emit FreeBetsHolderChanged(_freeBetsHolder);
    }

    /// @notice Sets the referrals contract
    function setReferrals(address _referrals) external onlyOwner {
        if (_referrals == address(0)) revert InvalidAddress();
        referrals = IReferrals(_referrals);
        emit ReferralsChanged(_referrals);
    }

    /// @notice Withdraws collateral from the contract bankroll
    function withdrawCollateral(address _collateral, address _recipient, uint _amount) external onlyOwner {
        uint balance = IERC20(_collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[_collateral];
        if (_amount > balance || balance - _amount < reserved) revert InsufficientAvailableLiquidity();
        address recipient = _recipient == address(0) ? owner : _recipient;
        IERC20(_collateral).safeTransfer(recipient, _amount);
        emit WithdrawnCollateral(_collateral, recipient, _amount);
    }

    /// @notice Sets Chainlink VRF configuration
    function setVrfConfig(
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations,
        bool _nativePayment
    ) external onlyOwner {
        if (_subscriptionId == 0) revert InvalidAmount();
        if (_keyHash == bytes32(0)) revert InvalidAmount();
        if (_callbackGasLimit == 0) revert InvalidAmount();

        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
        nativePayment = _nativePayment;

        emit VrfConfigChanged(_subscriptionId, _keyHash, _callbackGasLimit, _requestConfirmations, _nativePayment);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyRiskManager() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.RISK_MANAGING)) {
            revert InvalidSender();
        }
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING)) {
            revert InvalidSender();
        }
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.TICKET_PAUSER)) {
            revert InvalidSender();
        }
        _;
    }

    /* ========== EVENTS ========== */

    event SpinPlaced(uint indexed spinId, uint indexed requestId, address indexed user, address collateral, uint amount);

    event SpinResolved(
        uint indexed spinId,
        uint indexed requestId,
        address indexed user,
        uint8[3] reels,
        bool won,
        uint payout
    );

    event SpinCancelled(
        uint indexed spinId,
        uint indexed requestId,
        address indexed user,
        uint refundedAmount,
        bool adminCancelled
    );

    event SymbolsChanged(uint8 count, uint[] weights);
    event TriplePayoutChanged(uint8 symbol, uint multiplier);
    event PairPayoutChanged(uint8 symbol, uint multiplier);
    event MaxProfitUsdChanged(uint maxProfitUsd);
    event CancelTimeoutChanged(uint cancelTimeout);
    event HouseEdgeChanged(uint houseEdge);
    event MaxPayoutMultiplierChanged(uint maxPayoutMultiplier);
    event SupportedCollateralChanged(address collateral, bool supported);
    event PriceFeedKeyPerCollateralChanged(address collateral, bytes32 key);
    event ManagerChanged(address manager);
    event PriceFeedChanged(address priceFeed);
    event VrfCoordinatorChanged(address vrfCoordinator);
    event FreeBetsHolderChanged(address freeBetsHolder);
    event ReferralsChanged(address referrals);
    event ReferrerPaid(address indexed referrer, address indexed user, uint amount, uint betAmount, address collateral);
    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint amount);
    event VrfConfigChanged(
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        bool nativePayment
    );
}
