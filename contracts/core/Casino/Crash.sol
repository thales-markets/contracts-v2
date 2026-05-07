// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoCrash.sol";

/// @title Crash
/// @author Overtime
/// @notice Auto-cashout-target Crash. The user submits a target multiplier with their bet; one
/// VRF word resolves the crash point. If crashPoint >= target, the player wins `bet * target`;
/// otherwise the bet is lost. Fully one-shot, fully trustless — no hidden state, no race.
/// @dev House edge is constant across all targets by construction:
///   crashPoint distribution: P(M >= m) = (1 - HE) / m for m >= 1; P(M = 1) = HE
///   E[return per $1 stake at target T] = T * (1 - HE) / T = 1 - HE
///   → HE applies uniformly regardless of player's target choice
contract Crash is ICasinoCrash, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    /// @dev Crash multiplier discretization scale. 2^32 gives plenty of resolution
    uint256 private constant SCALE = 2 ** 32;

    /// @notice Floor on the configurable house edge (defends against accidental sub-2% setting)
    uint256 public constant MIN_HOUSE_EDGE_E18 = 0.02e18;

    /// @notice Cap on the configurable house edge
    uint256 public constant MAX_HOUSE_EDGE_E18 = 0.05e18;

    /// @notice Default maximum cashout target multiplier (capped at deploy time, owner-tunable).
    /// 1000x bounds the per-bet house liability without unduly restricting the long-tail UX
    uint256 public constant DEFAULT_MAX_TARGET_E18 = 1000e18;

    /// @notice Minimum allowed target — below 1.00x makes no sense
    uint256 public constant MIN_TARGET_E18 = 1e18 + 1;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidTarget();
    error InvalidHouseEdge();
    error MaxProfitExceeded();
    error BetNotFound();
    error BetNotOwner();
    error InvalidBetStatus();
    error CancelTimeoutNotReached();

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reserved;
        uint256 requestId;
        uint256 targetMultiplierE18;
        uint256 crashPointE18;
        BetStatus status;
        bool won;
    }

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ISportsAMMV2Manager public manager;

    uint256 public override houseEdgeE18;
    uint256 public override maxTargetE18;

    uint256 public nextBetId;

    mapping(uint256 => Bet) internal bets;
    mapping(uint256 => uint256) public requestIdToBetId;
    mapping(address => uint256[]) private userBetIds;

    uint256[40] private __gap;

    /* ========== INITIALIZER ========== */

    function initialize(address _owner, address _core, address _manager) external initializer {
        if (_owner == address(0) || _core == address(0) || _manager == address(0)) revert InvalidAddress();
        setOwner(_owner);
        initNonReentrant();
        core = ICasinoCoreV2(_core);
        manager = ISportsAMMV2Manager(_manager);
        nextBetId = 1;
        houseEdgeE18 = MIN_HOUSE_EDGE_E18; // 2% by default
        maxTargetE18 = DEFAULT_MAX_TARGET_E18;
    }

    /* ========== PLACE / CANCEL ========== */

    function placeBet(
        address collateral,
        uint256 amount,
        uint256 targetMultiplierE18,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        if (targetMultiplierE18 < MIN_TARGET_E18) revert InvalidTarget();
        if (targetMultiplierE18 > maxTargetE18) revert InvalidTarget();

        uint256 amountUsd = core.getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        // Worst-case house contribution (USD) = (target - 1) * amount
        uint256 worstHouseProfitUsd = (amountUsd * (targetMultiplierE18 - ONE)) / ONE;
        if (worstHouseProfitUsd > core.maxProfitUsd()) revert MaxProfitExceeded();

        core.pullFromUser(msg.sender, collateral, amount);
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);

        uint256 reservation = (amount * targetMultiplierE18) / ONE;
        core.reserveOrRevert(collateral, reservation);

        requestId = core.requestRandomWords(1);
        betId = nextBetId++;

        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.amount = amount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.reserved = reservation;
        b.targetMultiplierE18 = targetMultiplierE18;
        b.status = BetStatus.PENDING;

        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);

        emit BetPlaced(betId, requestId, msg.sender, collateral, amount, targetMultiplierE18);
    }

    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PENDING) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.PENDING) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];
        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;
        core.payOut(b.user, b.collateral, b.amount, false, b.amount);
        b.payout = b.amount;
        b.status = BetStatus.CANCELLED;
        b.resolvedAt = block.timestamp;
        emit BetCancelled(betId, b.user, b.amount, adminCancelled);
    }

    /* ========== VRF CALLBACK ========== */

    /// @dev `nonReentrant` defends against malicious-token transfer hooks calling cancelBet
    /// mid-payout for a double-spend
    function onVrfFulfilled(uint256 requestId, uint256[] calldata randomWords) external override nonReentrant {
        if (msg.sender != address(core)) revert InvalidSender();
        uint256 betId = requestIdToBetId[requestId];
        if (betId == 0) return;
        delete requestIdToBetId[requestId];

        Bet storage b = bets[betId];
        if (b.status != BetStatus.PENDING) return;

        uint256 crashPoint = _crashPointE18(randomWords[0], houseEdgeE18);
        bool won = crashPoint >= b.targetMultiplierE18;
        uint256 payout = won ? (b.amount * b.targetMultiplierE18) / ONE : 0;

        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;

        if (payout > 0) {
            core.payOut(b.user, b.collateral, payout, false, b.amount);
        }
        core.recordSettlement(b.collateral, b.amount, payout);

        if (!won) {
            core.payReferrer(b.user, b.collateral, b.amount);
        }

        b.crashPointE18 = crashPoint;
        b.won = won;
        b.payout = payout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(betId, b.requestId, b.user, crashPoint, won, payout);
    }

    /// @notice Derives the crash multiplier from a VRF random word and the configured edge.
    /// Distribution: P(M = 1.00) = HE; for M > 1, P(M >= m) = (1 - HE) / m
    function _crashPointE18(uint256 word, uint256 he) internal pure returns (uint256) {
        uint256 u = word % SCALE; // uniform [0, SCALE)
        uint256 heSlice = (he * SCALE) / ONE; // [0, SCALE * HE)
        if (u < heSlice) return ONE; // instant crash at 1.00x
        // M = (1 - HE) * SCALE / (SCALE - u), in 1e18-scaled output
        uint256 numerator = (ONE - he) * SCALE;
        uint256 denominator = SCALE - u;
        return numerator / denominator;
    }

    /* ========== ADMIN ========== */

    function setHouseEdge(uint256 newHouseEdgeE18) external onlyRiskManager {
        if (newHouseEdgeE18 < MIN_HOUSE_EDGE_E18 || newHouseEdgeE18 > MAX_HOUSE_EDGE_E18) revert InvalidHouseEdge();
        houseEdgeE18 = newHouseEdgeE18;
        emit HouseEdgeChanged(newHouseEdgeE18);
    }

    function setMaxTarget(uint256 newMaxTargetE18) external onlyRiskManager {
        if (newMaxTargetE18 < 2e18) revert InvalidAmount();
        maxTargetE18 = newMaxTargetE18;
        emit MaxTargetChanged(newMaxTargetE18);
    }

    function setCore(address _core) external onlyOwner {
        if (_core == address(0)) revert InvalidAddress();
        core = ICasinoCoreV2(_core);
    }

    function setManager(address _manager) external onlyOwner {
        if (_manager == address(0)) revert InvalidAddress();
        manager = ISportsAMMV2Manager(_manager);
    }

    function setPausedByRole(bool _paused) external onlyPauser {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) lastPauseTime = block.timestamp;
            emit PauseChanged(_paused);
        }
    }

    /* ========== VIEWS ========== */

    function getBetBase(
        uint256 betId
    )
        external
        view
        override
        returns (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            uint256 targetMultiplierE18,
            uint256 crashPointE18,
            bool won
        )
    {
        Bet storage b = bets[betId];
        return (
            b.user,
            b.collateral,
            b.amount,
            b.payout,
            b.placedAt,
            b.resolvedAt,
            b.status,
            b.targetMultiplierE18,
            b.crashPointE18,
            b.won
        );
    }

    function getUserBetIds(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (uint256[] memory ids) {
        uint256[] storage all = userBetIds[user];
        uint256 len = all.length;
        if (offset >= len) return new uint256[](0);
        uint256 remaining = len - offset;
        uint256 count = remaining < limit ? remaining : limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = all[len - 1 - offset - i];
        }
    }

    function getRecentBetIds(uint256 offset, uint256 limit) external view override returns (uint256[] memory ids) {
        uint256 latest = nextBetId - 1;
        if (offset >= latest) return new uint256[](0);
        uint256 start = latest - offset;
        uint256 count = start < limit ? start : limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = start - i;
        }
    }

    /* ========== MODIFIERS ========== */

    function _requireRole(ISportsAMMV2Manager.Role role) internal view {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, role)) revert InvalidSender();
    }

    modifier onlyRiskManager() {
        _requireRole(ISportsAMMV2Manager.Role.RISK_MANAGING);
        _;
    }
    modifier onlyResolver() {
        _requireRole(ISportsAMMV2Manager.Role.MARKET_RESOLVING);
        _;
    }
    modifier onlyPauser() {
        _requireRole(ISportsAMMV2Manager.Role.TICKET_PAUSER);
        _;
    }
}
