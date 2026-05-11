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
import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";

/// @title CasinoCoreV2
/// @author Overtime
/// @notice Singleton treasury and shared services for the V2 casino games (Three Card Poker,
/// Overtime Hold'em, Plinko, Hi-Lo). Holds USDC/WETH/OVER liquidity, the VRF
/// subscription configuration, the supported-collateral whitelist, and the free-bets / referrals
/// wiring. Registered games call into core for funds movement, randomness, and settlement
/// bookkeeping; core enforces a per-game cumulative-net-loss circuit breaker that auto-pauses
/// the offending game when its running P&L drops below the configured threshold.
/// @dev Existing v1 games (Roulette/Dice/Blackjack/Baccarat/Slots) are NOT migrated here. They
/// continue on their own per-contract bankrolls
contract CasinoCoreV2 is ICasinoCoreV2, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant USDC_UNIT = 1e6;

    /// @notice Lower bound on `cancelTimeout` enforced at config time
    uint public constant MIN_CANCEL_TIMEOUT = 30;

    /// @notice Default per-game net-loss circuit breaker if a game has no override (USD, 18-dec)
    uint public constant DEFAULT_MAX_NET_LOSS_PER_GAME_USD = 1000e18;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidCollateral();
    error InvalidPrice();
    error InvalidAmount();
    error InsufficientAvailableLiquidity();
    error GameNotRegistered();
    error GameAlreadyRegistered();
    error GameNotActive();
    error GameHasReservations();
    error VrfRequestUnknown();
    error UnderReservation();

    /* ========== STRUCTS ========== */

    struct CoreAddresses {
        address owner;
        address manager;
        address priceFeed;
        address vrfCoordinator;
        address freeBetsHolder;
        address referrals;
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

    /* ========== STATE ========== */

    // --- protocol wiring ---
    ISportsAMMV2Manager public manager;
    IPriceFeed public priceFeed;
    IVRFCoordinatorV2Plus public vrfCoordinator;
    address public override freeBetsHolder;
    IReferrals public referrals;

    // --- canonical collateral addresses (kept for parity with v1 games) ---
    address public usdc;
    address public weth;
    address public over;

    // --- shared risk params ---
    uint public override maxProfitUsd;
    uint public override cancelTimeout;

    // --- VRF v2.5 subscription ---
    uint256 public subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit;
    uint16 public requestConfirmations;
    bool public nativePayment;

    // --- collateral whitelist + price-feed keys ---
    mapping(address => bool) public override supportedCollateral;
    mapping(address => bytes32) public priceFeedKeyPerCollateral;

    // --- per-collateral aggregate reservation across all games ---
    mapping(address => uint) public override reservedProfitPerCollateral;

    // --- per-game per-collateral reservation (for deregister safety + analytics) ---
    mapping(address => mapping(address => uint)) public override reservedProfitPerGame;

    // --- registered games ---
    mapping(address => bool) public override isGameRegistered;
    address[] private _registeredGamesList;
    mapping(address => uint256) private _registeredGameIndex;

    // --- per-game pause + circuit breaker ---
    mapping(address => bool) public override gamePaused;
    mapping(address => bool) public override gameAutoPaused;
    mapping(address => int256) public override houseNetUsd;
    mapping(address => uint256) public override maxNetLossPerGameUsd;

    /// @notice Override of the default circuit-breaker threshold. Mutate via
    /// `setMaxNetLossPerGameUsd` and `setDefaultMaxNetLossPerGameUsd`. Reads should go through
    /// the `_maxNetLossUsd(game)` helper which falls back to the default
    uint256 public defaultMaxNetLossPerGameUsd;

    // --- VRF dispatch ---
    mapping(uint256 => address) public requestIdToGame;

    // --- enumerable collateral list (so deregisterGame can check reservations across all
    // configured collaterals, not just the canonical 3). Maintained by setCollateralConfig.
    // Placed here (after `requestIdToGame`) rather than alongside `supportedCollateral` to
    // preserve storage layout compatibility with the original v2 deploy
    address[] private _supportedCollateralsList;
    mapping(address => uint256) private _supportedCollateralIndex;

    // --- per-game override of the global `maxProfitUsd` cap. 0 = no override (fall back to
    // global). Set via `setMaxProfitUsdOverride`. Read via `effectiveMaxProfitUsd(game)` from
    // games at placeBet time. Lets V2 keep a single treasury while letting risk vary across games
    // with very different worst-case payout structures (e.g. HiLo 25x vs Hold'em 102x ante)
    mapping(address => uint256) public override maxProfitUsdOverride;

    // --- forward-compat storage gap. Reduced from 40 → 37 when `_supportedCollateralsList`,
    // `_supportedCollateralIndex`, and `maxProfitUsdOverride` were appended. Slots come AFTER all
    // pre-existing variables so upgrades from the original v2 deploy remain layout-compatible
    uint256[37] private __gap;

    /* ========== INITIALIZER ========== */

    /// @notice Initializes the treasury. Run once behind a TransparentUpgradeableProxy
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
            core.freeBetsHolder == address(0) ||
            collateralConfig.usdc == address(0) ||
            collateralConfig.weth == address(0) ||
            collateralConfig.over == address(0)
        ) {
            revert InvalidAddress();
        }
        if (_maxProfitUsd == 0) revert InvalidAmount();
        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        if (vrfConfig.callbackGasLimit == 0) revert InvalidAmount();
        // subscriptionId and keyHash are NOT enforced at init time to match the existing
        // casino deployment pattern (test/dev environments often plumb the real values via
        // setVrfConfig post-init). Setter enforces non-zero on subsequent updates

        setOwner(core.owner);
        initNonReentrant();

        manager = ISportsAMMV2Manager(core.manager);
        priceFeed = IPriceFeed(core.priceFeed);
        vrfCoordinator = IVRFCoordinatorV2Plus(core.vrfCoordinator);
        freeBetsHolder = core.freeBetsHolder;
        if (core.referrals != address(0)) referrals = IReferrals(core.referrals);

        usdc = collateralConfig.usdc;
        weth = collateralConfig.weth;
        over = collateralConfig.over;

        supportedCollateral[collateralConfig.usdc] = true;
        supportedCollateral[collateralConfig.weth] = true;
        supportedCollateral[collateralConfig.over] = true;
        priceFeedKeyPerCollateral[collateralConfig.weth] = collateralConfig.wethPriceFeedKey;
        priceFeedKeyPerCollateral[collateralConfig.over] = collateralConfig.overPriceFeedKey;
        _addToCollateralsList(collateralConfig.usdc);
        _addToCollateralsList(collateralConfig.weth);
        _addToCollateralsList(collateralConfig.over);

        maxProfitUsd = _maxProfitUsd;
        cancelTimeout = _cancelTimeout;
        defaultMaxNetLossPerGameUsd = DEFAULT_MAX_NET_LOSS_PER_GAME_USD;

        subscriptionId = vrfConfig.subscriptionId;
        keyHash = vrfConfig.keyHash;
        callbackGasLimit = vrfConfig.callbackGasLimit;
        requestConfirmations = vrfConfig.requestConfirmations;
        nativePayment = vrfConfig.nativePayment;
    }

    /* ========== GAME-FACING METHODS ========== */

    /// @inheritdoc ICasinoCoreV2
    function pullFromUser(address user, address collateral, uint256 amount) external override onlyActiveGame {
        _requireSupported(collateral);
        if (amount == 0) revert InvalidAmount();
        IERC20(collateral).safeTransferFrom(user, address(this), amount);
        emit StakePulled(msg.sender, user, collateral, amount);
    }

    /// @inheritdoc ICasinoCoreV2
    function useFreeBet(address user, address collateral, uint256 amount) external override onlyActiveGame {
        _requireSupported(collateral);
        if (amount == 0) revert InvalidAmount();
        IFreeBetsHolder(freeBetsHolder).useFreeBet(user, collateral, amount);
        emit FreeBetUsed(msg.sender, user, collateral, amount);
    }

    /// @inheritdoc ICasinoCoreV2
    /// @dev All referrals interactions are try/catch-wrapped. A broken or hostile referrals
    /// contract MUST NOT be able to revert a bet placement / fulfillment — otherwise it could be
    /// used to selectively block losing-bet settlements (an attacker-favorable cancel surface)
    function setReferrer(address referrer, address user) external override onlyActiveGame {
        if (referrer == address(0) || address(referrals) == address(0)) return;
        try referrals.setReferrer(referrer, user) {
            emit ReferrerSet(user, referrer);
        } catch {
            // silent: don't let a broken referrals contract block placeBet
        }
    }

    /// @inheritdoc ICasinoCoreV2
    function requestRandomWords(uint32 numWords) external override onlyActiveGame returns (uint256 requestId) {
        if (numWords == 0) revert InvalidAmount();
        requestId = vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
        requestIdToGame[requestId] = msg.sender;
        emit RandomWordsRequested(msg.sender, requestId, numWords);
    }

    /// @inheritdoc ICasinoCoreV2
    function reserveOrRevert(address collateral, uint256 amount) external override onlyActiveGame {
        if (amount == 0) return;
        _requireSupported(collateral);
        reservedProfitPerCollateral[collateral] += amount;
        reservedProfitPerGame[msg.sender][collateral] += amount;
        if (IERC20(collateral).balanceOf(address(this)) < reservedProfitPerCollateral[collateral]) {
            // rollback
            reservedProfitPerCollateral[collateral] -= amount;
            reservedProfitPerGame[msg.sender][collateral] -= amount;
            revert InsufficientAvailableLiquidity();
        }
        emit ReservationChanged(msg.sender, collateral, int256(amount), reservedProfitPerGame[msg.sender][collateral]);
    }

    /// @inheritdoc ICasinoCoreV2
    /// @dev Settle paths must call this BEFORE `payOut` so the payout doesn't overshoot bankroll.
    /// Allowed even when the calling game is paused / auto-paused — pending bets must always be
    /// able to settle. Only requires the game to have ever been registered
    function releaseReservation(address collateral, uint256 amount) external override onlyRegisteredGame {
        if (amount == 0) return;
        if (reservedProfitPerGame[msg.sender][collateral] < amount) revert UnderReservation();
        reservedProfitPerGame[msg.sender][collateral] -= amount;
        reservedProfitPerCollateral[collateral] -= amount;
        emit ReservationChanged(msg.sender, collateral, -int256(amount), reservedProfitPerGame[msg.sender][collateral]);
    }

    /// @inheritdoc ICasinoCoreV2
    /// @dev Free-bet branch: tokens go to FreeBetsHolder first, then `confirmCasinoBetResolved`
    /// is called. The confirm call is wrapped in try/catch — a broken FreeBetsHolder shouldn't
    /// block the settlement (would create a losing-bet cancel surface for free-bet flows). On
    /// confirm failure, tokens are stuck in FBH but the casino settlement completes
    function payOut(
        address user,
        address collateral,
        uint256 amount,
        bool isFreeBet,
        uint256 originalStake
    ) external override onlyRegisteredGame {
        if (amount == 0) return;
        if (isFreeBet) {
            IERC20(collateral).safeTransfer(freeBetsHolder, amount);
            try IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(user, collateral, amount, originalStake) {
                // ok
            } catch {
                emit FreeBetConfirmFailed(msg.sender, user, collateral, amount, originalStake);
            }
        } else {
            IERC20(collateral).safeTransfer(user, amount);
        }
        emit PayoutSent(msg.sender, user, collateral, amount, isFreeBet, originalStake);
    }

    /// @inheritdoc ICasinoCoreV2
    /// @dev EVERY referrals call is try/catch-wrapped. A malicious or broken referrals contract
    /// MUST NOT be able to revert a bet's settlement — that would let an attacker selectively
    /// block losing-bet fulfillments (winning fulfillments don't reach this branch), turning
    /// referrals into an attacker-favorable cancel surface. This was a known V1 audit issue
    function payReferrer(address user, address collateral, uint256 stake) external override onlyRegisteredGame {
        if (address(referrals) == address(0)) return;
        address referrer;
        try referrals.referrals(user) returns (address r) {
            referrer = r;
        } catch {
            return;
        }
        if (referrer == address(0)) return;
        uint256 referrerFee;
        try referrals.getReferrerFee(referrer) returns (uint256 f) {
            referrerFee = f;
        } catch {
            return;
        }
        if (referrerFee == 0) return;
        uint256 referrerAmount = (stake * referrerFee) / ONE;
        if (referrerAmount == 0) return;
        try IERC20(collateral).transfer(referrer, referrerAmount) returns (bool ok) {
            if (ok) emit ReferrerPaid(referrer, user, referrerAmount, stake, collateral);
            else emit ReferrerPayoutFailed(referrer, user, referrerAmount, stake, collateral);
        } catch {
            emit ReferrerPayoutFailed(referrer, user, referrerAmount, stake, collateral);
        }
    }

    /// @inheritdoc ICasinoCoreV2
    /// @dev `stake - payout` is the house's per-bet P&L in collateral units (positive when the
    /// house won, negative when the user won). Converted to USD-18-dec and added to the running
    /// gauge. When the gauge falls below `-_maxNetLossUsd(game)`, the game is auto-paused.
    ///
    /// `_getUsdValue` is try/catch-wrapped: if the price feed reverts (e.g., stale or broken),
    /// the bet still settles and the circuit breaker simply skips this round. Letting a price
    /// feed revert block VRF callbacks would create another losing-bet cancel surface
    function recordSettlement(address collateral, uint256 stake, uint256 payout) external override onlyRegisteredGame {
        int256 deltaUsd;
        if (payout >= stake) {
            uint256 lossCollateral = payout - stake;
            try this.getUsdValue(collateral, lossCollateral) returns (uint256 v) {
                deltaUsd = -int256(v);
            } catch {
                emit SettlementUsdConversionFailed(msg.sender, collateral, stake, payout);
                deltaUsd = 0;
            }
        } else {
            uint256 winCollateral = stake - payout;
            try this.getUsdValue(collateral, winCollateral) returns (uint256 v) {
                deltaUsd = int256(v);
            } catch {
                emit SettlementUsdConversionFailed(msg.sender, collateral, stake, payout);
                deltaUsd = 0;
            }
        }
        int256 newNet = houseNetUsd[msg.sender] + deltaUsd;
        houseNetUsd[msg.sender] = newNet;

        uint256 maxLoss = _maxNetLossUsd(msg.sender);
        if (!gameAutoPaused[msg.sender] && newNet < 0 && uint256(-newNet) >= maxLoss) {
            gameAutoPaused[msg.sender] = true;
            emit GameAutoPaused(msg.sender, newNet, maxLoss);
        }

        emit SettlementRecorded(msg.sender, collateral, stake, payout, newNet);
    }

    /* ========== VRF CALLBACK ========== */

    /// @notice Coordinator-only VRF entrypoint. Routes the random words to the game that
    /// requested them via the registered `ICasinoGameCallback` interface
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert InvalidSender();
        address game = requestIdToGame[requestId];
        if (game == address(0)) revert VrfRequestUnknown();
        // clear before dispatch to make replays no-ops and to free storage
        delete requestIdToGame[requestId];
        ICasinoGameCallback(game).onVrfFulfilled(requestId, randomWords);
        emit RandomWordsFulfilled(game, requestId);
    }

    /* ========== OWNER / RISK MANAGER ========== */

    /// @notice Registers a new game contract. Reverts on re-register.
    /// @dev Per-game `maxNetLossPerGameUsd[game]` defaults to 0, which `_maxNetLossUsd` reads
    /// as "use `defaultMaxNetLossPerGameUsd`" — no explicit init needed
    function registerGame(address game) external onlyOwner {
        if (game == address(0)) revert InvalidAddress();
        if (isGameRegistered[game]) revert GameAlreadyRegistered();
        isGameRegistered[game] = true;
        _registeredGameIndex[game] = _registeredGamesList.length;
        _registeredGamesList.push(game);
        emit GameRegistered(game);
    }

    /// @notice Removes a game from the registry. Requires zero reservations across EVERY
    /// currently-supported collateral (iterated from `_supportedCollateralsList`). Pause first,
    /// let pending bets settle, then deregister
    function deregisterGame(address game) external onlyOwner {
        if (!isGameRegistered[game]) revert GameNotRegistered();
        uint256 nCols = _supportedCollateralsList.length;
        for (uint256 i; i < nCols; ++i) {
            if (reservedProfitPerGame[game][_supportedCollateralsList[i]] != 0) {
                revert GameHasReservations();
            }
        }
        isGameRegistered[game] = false;
        // swap-and-pop on the array
        uint256 idx = _registeredGameIndex[game];
        uint256 lastIdx = _registeredGamesList.length - 1;
        if (idx != lastIdx) {
            address last = _registeredGamesList[lastIdx];
            _registeredGamesList[idx] = last;
            _registeredGameIndex[last] = idx;
        }
        _registeredGamesList.pop();
        delete _registeredGameIndex[game];
        emit GameDeregistered(game);
    }

    /// @notice Per-game pause flag (independent from treasury-wide pause). Either flag blocks
    /// new bets; settlement of in-flight bets is unaffected
    function setGamePaused(address game, bool _paused) external onlyPauser {
        if (gamePaused[game] != _paused) {
            gamePaused[game] = _paused;
            emit GamePauseChanged(game, _paused);
        }
    }

    /// @notice Clears the auto-pause flag and zeroes the running net-loss gauge for a game.
    /// Owner / risk-manager only — typically called after manual review
    function resetGameCircuitBreaker(address game) external onlyRiskManager {
        gameAutoPaused[game] = false;
        houseNetUsd[game] = 0;
        emit GameCircuitBreakerReset(game);
    }

    /// @notice Sets a per-game override for the circuit-breaker threshold. Pass 0 to revert to
    /// the default
    function setMaxNetLossPerGameUsd(address game, uint256 value) external onlyOwner {
        maxNetLossPerGameUsd[game] = value;
        emit MaxNetLossPerGameUsdChanged(game, value);
    }

    /// @notice Sets the default per-game circuit-breaker threshold applied to any game without
    /// an override
    function setDefaultMaxNetLossPerGameUsd(uint256 value) external onlyOwner {
        if (value == 0) revert InvalidAmount();
        defaultMaxNetLossPerGameUsd = value;
        emit DefaultMaxNetLossPerGameUsdChanged(value);
    }

    /// @notice Updates risk params. Pass 0 on a field to leave it untouched
    function setRiskParams(uint _maxProfitUsd, uint _cancelTimeout) external onlyOwner {
        if (_maxProfitUsd != 0) maxProfitUsd = _maxProfitUsd;
        if (_cancelTimeout != 0) {
            if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
            cancelTimeout = _cancelTimeout;
        }
        emit RiskParamsChanged(_maxProfitUsd, _cancelTimeout);
    }

    /// @notice Sets a per-game override of the global `maxProfitUsd`. Pass 0 to clear the
    /// override and fall back to the global value. Lets the risk manager tune the per-bet
    /// profit cap per game without affecting others — useful when games have very different
    /// worst-case payout multipliers
    function setMaxProfitUsdOverride(address game, uint256 value) external onlyOwner {
        if (game == address(0)) revert InvalidAddress();
        maxProfitUsdOverride[game] = value;
        emit MaxProfitUsdOverrideChanged(game, value);
    }

    /// @notice Returns the effective per-bet profit cap for `game`: the override if set,
    /// otherwise the global `maxProfitUsd`. Games should call this (not `maxProfitUsd()`) at
    /// placeBet to enforce their cap
    function effectiveMaxProfitUsd(address game) external view override returns (uint256) {
        uint256 override_ = maxProfitUsdOverride[game];
        return override_ == 0 ? maxProfitUsd : override_;
    }

    /// @notice Adds, removes, or re-keys a collateral. Both `currencyKey` and `isSupported` are
    /// always written — pass current values for fields you don't want to change. Also maintains
    /// the enumerable collateral list (`_supportedCollateralsList`) used by `deregisterGame`
    function setCollateralConfig(address collateral, bytes32 currencyKey, bool isSupported) external onlyOwner {
        if (collateral == address(0)) revert InvalidAddress();
        bool wasSupported = supportedCollateral[collateral];
        supportedCollateral[collateral] = isSupported;
        priceFeedKeyPerCollateral[collateral] = currencyKey;
        if (isSupported && !wasSupported) {
            _addToCollateralsList(collateral);
        } else if (!isSupported && wasSupported) {
            _removeFromCollateralsList(collateral);
        }
        emit CollateralConfigChanged(collateral, currencyKey, isSupported);
    }

    /// @notice Updates protocol addresses. Pass `address(0)` for any slot you want to skip
    function setAddresses(
        address _manager,
        address _priceFeed,
        address _vrfCoordinator,
        address _freeBetsHolder,
        address _referrals
    ) external onlyOwner {
        if (_manager != address(0)) manager = ISportsAMMV2Manager(_manager);
        if (_priceFeed != address(0)) priceFeed = IPriceFeed(_priceFeed);
        if (_vrfCoordinator != address(0)) vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        if (_freeBetsHolder != address(0)) freeBetsHolder = _freeBetsHolder;
        if (_referrals != address(0)) referrals = IReferrals(_referrals);
        emit AddressesChanged(_manager, _priceFeed, _vrfCoordinator, _freeBetsHolder, _referrals);
    }

    /// @notice Updates the Chainlink VRF configuration
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

    /// @notice Treasury-wide pause. Blocks new bets across every registered game while leaving
    /// in-flight settlement intact
    function setPausedByRole(bool _paused) external onlyPauser {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                lastPauseTime = block.timestamp;
            }
            emit PauseChanged(_paused);
        }
    }

    /// @notice Withdraws non-reserved collateral from the treasury bankroll
    function withdrawCollateral(address _collateral, address _recipient, uint _amount) external onlyOwner nonReentrant {
        uint balance = IERC20(_collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[_collateral];
        if (_amount > balance || balance - _amount < reserved) revert InsufficientAvailableLiquidity();
        address recipient = _recipient == address(0) ? owner : _recipient;
        IERC20(_collateral).safeTransfer(recipient, _amount);
        emit WithdrawnCollateral(_collateral, recipient, _amount);
    }

    /* ========== VIEWS ========== */

    /// @inheritdoc ICasinoCoreV2
    function gameInactiveReason(address game) external view override returns (GameInactiveReason) {
        if (!isGameRegistered[game]) return GameInactiveReason.NOT_REGISTERED;
        if (paused) return GameInactiveReason.TREASURY_PAUSED;
        if (gamePaused[game]) return GameInactiveReason.GAME_PAUSED;
        if (gameAutoPaused[game]) return GameInactiveReason.AUTO_PAUSED;
        return GameInactiveReason.NONE;
    }

    /// @inheritdoc ICasinoCoreV2
    function getCollateralPrice(address collateral) public view override returns (uint256) {
        return _getCollateralPrice(collateral);
    }

    /// @inheritdoc ICasinoCoreV2
    function getUsdValue(address collateral, uint256 amount) external view override returns (uint256) {
        return _getUsdValue(collateral, amount);
    }

    /// @inheritdoc ICasinoCoreV2
    function getAvailableLiquidity(address collateral) external view override returns (uint256) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint balance = IERC20(collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[collateral];
        return balance > reserved ? balance - reserved : 0;
    }

    /// @inheritdoc ICasinoCoreV2
    function getRegisteredGames() external view override returns (address[] memory) {
        return _registeredGamesList;
    }

    /// @notice Returns every collateral currently in the supported set. Order is not stable
    /// (swap-and-pop on remove). Used by FE/ops; `deregisterGame` iterates this internally
    function getSupportedCollaterals() external view returns (address[] memory) {
        return _supportedCollateralsList;
    }

    /* ========== INTERNAL ========== */

    function _requireSupported(address collateral) internal view {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
    }

    function _addToCollateralsList(address c) internal {
        _supportedCollateralIndex[c] = _supportedCollateralsList.length;
        _supportedCollateralsList.push(c);
    }

    function _removeFromCollateralsList(address c) internal {
        uint256 idx = _supportedCollateralIndex[c];
        uint256 lastIdx = _supportedCollateralsList.length - 1;
        if (idx != lastIdx) {
            address last = _supportedCollateralsList[lastIdx];
            _supportedCollateralsList[idx] = last;
            _supportedCollateralIndex[last] = idx;
        }
        _supportedCollateralsList.pop();
        delete _supportedCollateralIndex[c];
    }

    function _getCollateralPrice(address collateral) internal view returns (uint256) {
        _requireSupported(collateral);
        if (collateral == usdc) return ONE;
        bytes32 currencyKey = priceFeedKeyPerCollateral[collateral];
        if (currencyKey == bytes32(0)) revert InvalidCollateral();
        uint price = priceFeed.rateForCurrency(currencyKey);
        if (price == 0) revert InvalidPrice();
        return price;
    }

    function _getUsdValue(address collateral, uint256 amount) internal view returns (uint256) {
        if (collateral == usdc) return (amount * ONE) / USDC_UNIT;
        uint price = _getCollateralPrice(collateral);
        return (amount * price) / ONE;
    }

    function _maxNetLossUsd(address game) internal view returns (uint256) {
        uint256 v = maxNetLossPerGameUsd[game];
        return v == 0 ? defaultMaxNetLossPerGameUsd : v;
    }

    /* ========== MODIFIERS ========== */

    function _requireRole(ISportsAMMV2Manager.Role role) internal view {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, role)) revert InvalidSender();
    }

    modifier onlyRiskManager() {
        _requireRole(ISportsAMMV2Manager.Role.RISK_MANAGING);
        _;
    }
    modifier onlyPauser() {
        _requireRole(ISportsAMMV2Manager.Role.TICKET_PAUSER);
        _;
    }

    /// @notice Strictest gate: caller must be registered AND not paused at ANY layer (treasury /
    /// per-game / auto-pause). Used by new-bet entry points (pullFromUser, requestRandomWords,
    /// reserveOrRevert, useFreeBet, setReferrer)
    modifier onlyActiveGame() {
        if (!isGameRegistered[msg.sender]) revert GameNotRegistered();
        if (paused || gamePaused[msg.sender] || gameAutoPaused[msg.sender]) revert GameNotActive();
        _;
    }

    /// @notice Looser gate: caller must be registered. Pause flags are NOT checked, so in-flight
    /// bets can always settle. Used by settlement-side entry points (releaseReservation, payOut,
    /// recordSettlement, payReferrer)
    modifier onlyRegisteredGame() {
        if (!isGameRegistered[msg.sender]) revert GameNotRegistered();
        _;
    }
}
