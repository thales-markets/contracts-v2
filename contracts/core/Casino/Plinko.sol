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
/// @notice Single-shot Plinko. User picks rows (8/12/16) and risk level (LOW/MED/HIGH); one
/// VRF word is consumed; the contract derives the bounce sequence from the word's low `rows`
/// bits, where each bit chooses left (0) or right (1). The slot index = popcount(low rows bits)
/// addresses a `(rows, risk)`-specific paytable. Multipliers stored in 1e18 precision
/// @dev All funds, randomness, free-bets, and circuit-breaker accounting live in `CasinoCoreV2`.
///
/// Default paytables are calibrated for ≥2% theoretical house edge across all 9 (rows, risk)
/// combinations (see project memory `casino_edge_floor`). Realized HE is verified by the 100k
/// Monte Carlo sim
contract Plinko is ICasinoPlinko, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant ROWS_MIN = 8;
    uint8 private constant ROWS_MAX = 16;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidRows();
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
        uint8 rows;
        Risk risk;
        uint8 slotIndex;
    }

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ISportsAMMV2Manager public manager;

    uint256 public nextBetId;

    mapping(uint256 => Bet) internal bets;
    mapping(uint256 => uint256) public requestIdToBetId;
    mapping(address => uint256[]) private userBetIds;

    /// @notice paytables[rows][risk] = [mult0, mult1, ..., multRows] — length is rows + 1
    mapping(uint8 => mapping(uint8 => uint256[])) internal paytables;

    /// @notice maxPaytableMultiplier[rows][risk] cached for fast reservation calc
    mapping(uint8 => mapping(uint8 => uint256)) internal maxMultiplier;

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

    /// @dev Default paytables — each calibrated to ≥2% theoretical house edge.
    /// 8-row weights: [1,8,28,56,70,56,28,8,1] (sum = 256)
    /// 12-row weights: [1,12,66,220,495,792,924,792,495,220,66,12,1] (sum = 4096)
    /// 16-row weights: [1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1] (sum = 65536)
    function _setDefaultPaytables() internal {
        // 8 rows
        _set8(uint8(Risk.LOW), [uint256(56e17), 205e16, 105e16, 1e18, 5e17, 1e18, 105e16, 205e16, 56e17]);
        _set8(uint8(Risk.MED), [uint256(13e18), 3e18, 12e17, 7e17, 4e17, 7e17, 12e17, 3e18, 13e18]);
        _set8(uint8(Risk.HIGH), [uint256(29e18), 4e18, 14e17, 3e17, 2e17, 3e17, 14e17, 4e18, 29e18]);

        // 12 rows
        _set12(
            uint8(Risk.LOW),
            [uint256(10e18), 3e18, 16e17, 14e17, 11e17, 1e18, 45e16, 1e18, 11e17, 14e17, 16e17, 3e18, 10e18]
        );
        _set12(
            uint8(Risk.MED),
            [uint256(33e18), 11e18, 4e18, 2e18, 11e17, 55e16, 3e17, 55e16, 11e17, 2e18, 4e18, 11e18, 33e18]
        );
        _set12(
            uint8(Risk.HIGH),
            [uint256(110e18), 22e18, 85e17, 2e18, 5e17, 3e17, 3e17, 3e17, 5e17, 2e18, 85e17, 22e18, 110e18]
        );

        // 16 rows
        _set16(
            uint8(Risk.LOW),
            [
                uint256(16e18),
                9e18,
                2e18,
                14e17,
                14e17,
                12e17,
                11e17,
                1e18,
                4e17,
                1e18,
                11e17,
                12e17,
                14e17,
                14e17,
                2e18,
                9e18,
                16e18
            ]
        );
        _set16(
            uint8(Risk.MED),
            [
                uint256(50e18),
                16e18,
                4e18,
                2e18,
                15e17,
                12e17,
                11e17,
                85e16,
                5e17,
                85e16,
                11e17,
                12e17,
                15e17,
                2e18,
                4e18,
                16e18,
                50e18
            ]
        );
        _set16(
            uint8(Risk.HIGH),
            [
                uint256(900e18),
                110e18,
                26e18,
                10e18,
                35e17,
                16e17,
                4e17,
                2e17,
                2e17,
                2e17,
                4e17,
                16e17,
                35e17,
                10e18,
                26e18,
                110e18,
                900e18
            ]
        );
    }

    function _set8(uint8 risk, uint256[9] memory mults) internal {
        uint256[] storage row = paytables[8][risk];
        uint256 maxM;
        for (uint256 i; i < 9; ++i) {
            row.push(mults[i]);
            if (mults[i] > maxM) maxM = mults[i];
        }
        maxMultiplier[8][risk] = maxM;
    }

    function _set12(uint8 risk, uint256[13] memory mults) internal {
        uint256[] storage row = paytables[12][risk];
        uint256 maxM;
        for (uint256 i; i < 13; ++i) {
            row.push(mults[i]);
            if (mults[i] > maxM) maxM = mults[i];
        }
        maxMultiplier[12][risk] = maxM;
    }

    function _set16(uint8 risk, uint256[17] memory mults) internal {
        uint256[] storage row = paytables[16][risk];
        uint256 maxM;
        for (uint256 i; i < 17; ++i) {
            row.push(mults[i]);
            if (mults[i] > maxM) maxM = mults[i];
        }
        maxMultiplier[16][risk] = maxM;
    }

    /* ========== PLACE / CANCEL ========== */

    /// @notice Places a Plinko bet. One VRF word resolves it
    function placeBet(
        address collateral,
        uint256 amount,
        uint8 rows,
        Risk risk,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        uint256 reservation = _validateAndReserve(collateral, amount, rows, risk);
        core.pullFromUser(msg.sender, collateral, amount);
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);
        core.reserveOrRevert(collateral, reservation);
        requestId = core.requestRandomWords(1);
        betId = nextBetId++;
        _writeBet(betId, requestId, collateral, amount, rows, risk, reservation);
        emit BetPlaced(betId, requestId, msg.sender, collateral, amount, rows, risk);
    }

    function _validateAndReserve(
        address collateral,
        uint256 amount,
        uint8 rows,
        Risk risk
    ) internal view returns (uint256 reservation) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        if (!_isSupportedRows(rows)) revert InvalidRows();
        uint256 maxM = maxMultiplier[rows][uint8(risk)];
        if (maxM == 0) revert InvalidRisk();
        uint256 amountUsd = core.getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();
        if ((amountUsd * (maxM - ONE)) / ONE > core.maxProfitUsd()) revert MaxProfitExceeded();
        reservation = (amount * maxM) / ONE;
    }

    function _writeBet(
        uint256 betId,
        uint256 requestId,
        address collateral,
        uint256 amount,
        uint8 rows,
        Risk risk,
        uint256 reservation
    ) internal {
        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.amount = amount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.reserved = reservation;
        b.rows = rows;
        b.risk = risk;
        b.status = BetStatus.PENDING;
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

        uint8 slot = _slotFromWord(randomWords[0], b.rows);
        uint256 mult = paytables[b.rows][uint8(b.risk)][slot];
        uint256 payout = (b.amount * mult) / ONE;

        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;

        if (payout > 0) {
            core.payOut(b.user, b.collateral, payout, false, b.amount);
        }
        core.recordSettlement(b.collateral, b.amount, payout);

        if (payout < b.amount) {
            core.payReferrer(b.user, b.collateral, b.amount - payout);
        }

        b.slotIndex = slot;
        b.multiplierE18 = mult;
        b.payout = payout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(betId, b.requestId, b.user, slot, mult, payout);
    }

    /// @notice Derives the slot index from the VRF word: take low `rows` bits, count 1-bits
    function _slotFromWord(uint256 word, uint8 rows) internal pure returns (uint8 slot) {
        uint256 mask = (uint256(1) << rows) - 1;
        uint256 bits = word & mask;
        // popcount via simple loop — rows ≤ 16 so this is cheap
        uint8 c;
        for (uint8 i; i < rows; ++i) {
            if ((bits & (uint256(1) << i)) != 0) ++c;
        }
        slot = c;
    }

    function _isSupportedRows(uint8 rows) internal pure returns (bool) {
        return rows == 8 || rows == 12 || rows == 16;
    }

    /* ========== ADMIN: PAYTABLE MANAGEMENT ========== */

    /// @notice Owner can replace a (rows, risk) paytable. `multipliers` length must equal rows + 1
    function setPaytable(uint8 rows, Risk risk, uint256[] calldata multipliers) external onlyRiskManager {
        if (!_isSupportedRows(rows)) revert InvalidRows();
        if (multipliers.length != uint256(rows) + 1) revert PaytableLengthMismatch();
        uint8 r = uint8(risk);
        delete paytables[rows][r];
        uint256 maxM;
        for (uint256 i; i < multipliers.length; ++i) {
            paytables[rows][r].push(multipliers[i]);
            if (multipliers[i] > maxM) maxM = multipliers[i];
        }
        maxMultiplier[rows][r] = maxM;
        emit PaytableUpdated(rows, risk, multipliers);
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
            uint8 rows,
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
            b.rows,
            b.risk,
            b.slotIndex,
            b.multiplierE18
        );
    }

    function getPaytable(uint8 rows, Risk risk) external view override returns (uint256[] memory) {
        return paytables[rows][uint8(risk)];
    }

    function getMaxMultiplierE18(uint8 rows, Risk risk) external view override returns (uint256) {
        return maxMultiplier[rows][uint8(risk)];
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

    /* ========== ADMIN ========== */

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
