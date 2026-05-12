// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoPlinko.sol";

/// @title Plinko
/// @author Overtime
/// @notice Single-shot 8-row Plinko. User picks a risk level (LOW/MED/HIGH); one VRF word is
/// consumed; the contract derives the bounce sequence from the word's low 8 bits, where each
/// bit chooses left (0) or right (1). The slot index = popcount(low 8 bits) addresses the
/// risk-specific paytable. Multipliers stored in 1e18 precision
/// @dev All funds, randomness, free-bets, and circuit-breaker accounting live in `CasinoCoreV2`.
///
/// Default paytables are calibrated for ≥2% theoretical house edge (see project memory
/// `casino_edge_floor`). Realized HE is verified by the 100k Monte Carlo sim
contract Plinko is ICasinoPlinko, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant ROWS = 8;
    uint8 private constant SLOTS = 9; // ROWS + 1

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidRisk();
    error PaytableLengthMismatch();
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
        uint256 multiplierE18;
        BetStatus status;
        Risk risk;
        uint8 slotIndex;
        // Stake was pulled from FreeBetsHolder via core.useFreeBet instead of core.pullFromUser.
        // Routes payouts back to FBH on resolve / cancel and skips referrer payment on losses
        bool isFreeBet;
    }

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ISportsAMMV2Manager public manager;

    uint256 public nextBetId;

    mapping(uint256 => Bet) internal bets;
    mapping(uint256 => uint256) public requestIdToBetId;
    mapping(address => uint256[]) private userBetIds;

    /// @notice paytables[risk] = [mult0, ..., mult8] (length 9)
    mapping(uint8 => uint256[]) internal paytables;

    /// @notice Max multiplier per risk, cached for fast reservation calc
    mapping(uint8 => uint256) internal maxMultiplier;

    uint256[40] private __gap;

    /* ========== INITIALIZER ========== */

    function initialize(address _owner, address _core, address _manager) external initializer {
        if (_owner == address(0) || _core == address(0) || _manager == address(0)) revert InvalidAddress();
        setOwner(_owner);
        initNonReentrant();
        core = ICasinoCoreV2(_core);
        manager = ISportsAMMV2Manager(_manager);
        nextBetId = 1;

        _setDefaultPaytables();
    }

    /// @dev Default 8-row paytables calibrated to ≥2% theoretical house edge.
    /// 8-row outcome weights: [1,8,28,56,70,56,28,8,1] (sum = 256)
    function _setDefaultPaytables() internal {
        _setPaytableInternal(uint8(Risk.LOW), [uint256(56e17), 205e16, 105e16, 1e18, 5e17, 1e18, 105e16, 205e16, 56e17]);
        _setPaytableInternal(uint8(Risk.MED), [uint256(13e18), 3e18, 12e17, 7e17, 4e17, 7e17, 12e17, 3e18, 13e18]);
        _setPaytableInternal(uint8(Risk.HIGH), [uint256(29e18), 4e18, 14e17, 3e17, 2e17, 3e17, 14e17, 4e18, 29e18]);
    }

    function _setPaytableInternal(uint8 risk, uint256[SLOTS] memory mults) internal {
        uint256[] storage row = paytables[risk];
        uint256 maxM;
        for (uint256 i; i < SLOTS; ++i) {
            row.push(mults[i]);
            if (mults[i] > maxM) maxM = mults[i];
        }
        maxMultiplier[risk] = maxM;
    }

    /* ========== PLACE / CANCEL ========== */

    /// @notice Places a Plinko bet. One VRF word resolves it
    function placeBet(
        address collateral,
        uint256 amount,
        Risk risk,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, amount, risk, referrer, false);
    }

    /// @inheritdoc ICasinoPlinko
    function placeBetWithFreeBet(
        address collateral,
        uint256 amount,
        Risk risk,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, amount, risk, referrer, true);
    }

    function _placeBet(
        address collateral,
        uint256 amount,
        Risk risk,
        address referrer,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        uint256 reservation = _validateAndReserve(collateral, amount, risk);
        if (isFreeBet) {
            core.useFreeBet(msg.sender, collateral, amount);
        } else {
            core.pullFromUser(msg.sender, collateral, amount);
        }
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);
        core.reserveOrRevert(collateral, reservation);
        requestId = core.requestRandomWords(1);
        betId = nextBetId++;
        _writeBet(betId, requestId, collateral, amount, risk, reservation, isFreeBet);
        emit BetPlaced(betId, requestId, msg.sender, collateral, amount, risk);
    }

    function _validateAndReserve(address collateral, uint256 amount, Risk risk) internal view returns (uint256 reservation) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        uint256 maxM = maxMultiplier[uint8(risk)];
        if (maxM == 0) revert InvalidRisk();
        uint256 amountUsd = core.getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();
        if ((amountUsd * (maxM - ONE)) / ONE > core.effectiveMaxProfitUsd(address(this))) revert MaxProfitExceeded();
        reservation = (amount * maxM) / ONE;
    }

    function _writeBet(
        uint256 betId,
        uint256 requestId,
        address collateral,
        uint256 amount,
        Risk risk,
        uint256 reservation,
        bool isFreeBet
    ) internal {
        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.amount = amount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.reserved = reservation;
        b.risk = risk;
        b.status = BetStatus.PENDING;
        b.isFreeBet = isFreeBet;
        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);
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
        core.payOut(b.user, b.collateral, b.amount, b.isFreeBet, b.amount);
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

        uint8 slot = _slotFromWord(randomWords[0]);
        uint256 mult = paytables[uint8(b.risk)][slot];
        uint256 payout = (b.amount * mult) / ONE;

        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;

        if (payout > 0) {
            core.payOut(b.user, b.collateral, payout, b.isFreeBet, b.amount);
        }
        core.recordSettlement(b.collateral, b.amount, payout);

        // Skip referrer payment on free bets — user lost no real funds, so no referral fee
        if (payout < b.amount && !b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, b.amount - payout);
        }

        b.slotIndex = slot;
        b.multiplierE18 = mult;
        b.payout = payout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(betId, b.requestId, b.user, slot, mult, payout);
    }

    /// @notice Derives the slot index from the VRF word: take low 8 bits, count 1-bits.
    /// Result is in [0, 8] (9 possible slots)
    function _slotFromWord(uint256 word) internal pure returns (uint8 slot) {
        uint256 bits = word & 0xff; // low 8 bits
        uint8 c;
        for (uint8 i; i < ROWS; ++i) {
            if ((bits & (uint256(1) << i)) != 0) ++c;
        }
        slot = c;
    }

    /* ========== ADMIN: PAYTABLE MANAGEMENT ========== */

    /// @notice Owner can replace a risk-level paytable. `multipliers` length must equal 9
    function setPaytable(Risk risk, uint256[] calldata multipliers) external onlyOwner {
        if (multipliers.length != SLOTS) revert PaytableLengthMismatch();
        uint8 r = uint8(risk);
        delete paytables[r];
        uint256 maxM;
        for (uint256 i; i < multipliers.length; ++i) {
            paytables[r].push(multipliers[i]);
            if (multipliers[i] > maxM) maxM = multipliers[i];
        }
        maxMultiplier[r] = maxM;
        emit PaytableUpdated(risk, multipliers);
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
            Risk risk,
            uint8 slotIndex,
            uint256 multiplierE18
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
            b.risk,
            b.slotIndex,
            b.multiplierE18
        );
    }

    function getFullRecord(uint256 betId) external view override returns (FullRecord memory r) {
        Bet storage b = bets[betId];
        r.betId = betId;
        r.user = b.user;
        r.collateral = b.collateral;
        r.amount = b.amount;
        r.payout = b.payout;
        r.placedAt = b.placedAt;
        r.resolvedAt = b.resolvedAt;
        r.status = b.status;
        r.risk = b.risk;
        r.slotIndex = b.slotIndex;
        r.multiplierE18 = b.multiplierE18;
    }

    function getPaytable(Risk risk) external view override returns (uint256[] memory) {
        return paytables[uint8(risk)];
    }

    function getMaxMultiplierE18(Risk risk) external view override returns (uint256) {
        return maxMultiplier[uint8(risk)];
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

    /* ========== ADMIN: WIRING + PAUSE ========== */

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
