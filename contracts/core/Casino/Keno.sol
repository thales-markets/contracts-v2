// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoKeno.sol";

/// @title Keno
/// @author Overtime
/// @notice Single-shot Keno against a fixed 80-number pool. Player picks 1–10 numbers; one VRF
/// word draws 20 unique numbers via partial Fisher-Yates; payout = `bet × paytable[picks][hits]`.
/// Multipliers in 1e18 precision, hard-capped at 300x. Default paytables are strictly monotonic
/// per spot count (every additional hit pays strictly more, except the leading 0-bands)
/// @dev Two storage savers worth flagging:
///   - Picks and drawn numbers are stored as 128-bit bitmasks (numbers 1..80 → bits 0..79)
///   - Paytables sized exactly per spot count (`picks + 1` entries)
contract Keno is ICasinoKeno, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;

    /// @notice Keno pool size (numbers 1..POOL_SIZE)
    uint8 public constant POOL_SIZE = 80;

    /// @notice Numbers drawn per round
    uint8 public constant DRAW_COUNT = 20;

    /// @notice Min/max picks the player can choose
    uint8 public constant MIN_PICKS = 1;
    uint8 public constant MAX_PICKS = 10;

    /// @notice Min/max stake in USD (1e18 precision)
    uint256 public constant MIN_BET_USD = 3e18;
    uint256 public constant MAX_BET_USD = 10e18;

    /// @notice Hard cap on any paytable entry. With MAX_BET_USD = $10, per-bet liability ≤ $3000;
    /// `effectiveMaxProfitUsd(keno)` should be ≥ $3000 for max bets to be allowed
    uint256 public constant MAX_MULTIPLIER_E18 = 300e18;

    /// @dev Bits per Fisher-Yates swap from the VRF word. 16 bits gives <0.04% bias on any
    /// remaining size in [60, 80]. Need 20 swaps total → 20 × 16 = 320 bits, so we re-hash
    /// the cursor once after consuming all 16 chunks of the first 256-bit word
    uint8 private constant SHUFFLE_SHIFT_BITS = 16;
    uint64 private constant SHUFFLE_SHIFT_MASK = 0xFFFF;
    uint8 private constant CHUNKS_PER_WORD = 16; // 256 / 16

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidPicks();
    error PaytableLengthMismatch();
    error MultiplierTooHigh();
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
        uint128 picksMask; // bitmask over [1..80] using bit (n-1)
        uint128 drawnMask; // bitmask of the 20 drawn numbers (set in callback)
        uint256 multiplierE18;
        BetStatus status;
        uint8 picksCount;
        uint8 hits;
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

    /// @notice paytables[picksCount] = multipliers indexed by hit count, length = picksCount + 1
    mapping(uint8 => uint256[]) internal paytables;

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

    /// @dev Default paytables calibrated to 1.9%–3.1% edge per spot count. Strictly monotonic
    /// per spot count: every additional hit pays strictly more (except the leading 0-bands of
    /// near-zero-probability low-hit outcomes). Top tier of picks 8–10 reaches the 300x cap;
    /// rare-jackpot probability is vanishingly small (Pick 10 hitting 10 = 1.12e-7), so cap
    /// changes barely move RTP — most RTP comes from the 3–6 hit range
    function _setDefaultPaytables() internal {
        // Pick 1:  RTP 98.000% (edge 2.000%)
        _setDefault(1, _arr2(0, (392 * ONE) / 100));
        // Pick 2:  RTP 98.101% (edge 1.899%)
        _setDefault(2, _arr3(0, ONE, 10 * ONE));
        // Pick 3:  RTP 97.128% (edge 2.872%)
        _setDefault(3, _arr4(0, 0, 2 * ONE, 50 * ONE));
        // Pick 4:  RTP 97.668% (edge 2.332%)
        _setDefault(4, _arr5(0, 0, ONE, 12 * ONE, 80 * ONE));
        // Pick 5:  RTP 97.290% (edge 2.710%)
        _setDefault(5, _arr6(0, 0, ONE, 3 * ONE, 33 * ONE, 80 * ONE));
        // Pick 6:  RTP 97.942% (edge 2.058%)
        _setDefault(6, _arr7(0, 0, ONE, 2 * ONE, 8 * ONE, 55 * ONE, 100 * ONE));
        // Pick 7:  Top tier 250x (was 100x duplicate). Adds ~0.04% RTP — still ~3% edge
        _setDefault(7, _arr8(0, 0, 0, 2 * ONE, 6 * ONE, 27 * ONE, 100 * ONE, 250 * ONE));
        // Pick 8:  Top tier 300x (was 100x duplicate). Adds ~0.10% RTP — still ~2.2% edge
        _setDefault(8, _arr9(0, 0, 0, ONE, 4 * ONE, 18 * ONE, 38 * ONE, 100 * ONE, 300 * ONE));
        // Pick 9:  Tail [150, 300] (was [100, 100]). Adds ~0.07% RTP — still ~2.4% edge
        _setDefault(9, _arr10(0, 0, 0, ONE, 3 * ONE, 7 * ONE, 20 * ONE, 70 * ONE, 150 * ONE, 300 * ONE));
        // Pick 10: Tail [100, 200, 300] (was [100, 100, 100]). Adds ~0.15% RTP — still ~2.9% edge
        _setDefault(10, _arr11(0, 0, 0, ONE, 2 * ONE, 4 * ONE, 11 * ONE, 38 * ONE, 100 * ONE, 200 * ONE, 300 * ONE));
    }

    function _setDefault(uint8 picksCount, uint256[] memory mults) internal {
        uint256[] storage tbl = paytables[picksCount];
        for (uint256 i; i < mults.length; ++i) {
            tbl.push(mults[i]);
        }
    }

    /* ========== PLACE / CANCEL ========== */

    /// @notice Place a Keno bet. `picks` must be sorted ascending, deduplicated, all in [1, 80]
    function placeBet(
        address collateral,
        uint256 amount,
        uint8[] calldata picks,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, amount, picks, referrer, false);
    }

    /// @inheritdoc ICasinoKeno
    function placeBetWithFreeBet(
        address collateral,
        uint256 amount,
        uint8[] calldata picks,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, amount, picks, referrer, true);
    }

    function _placeBet(
        address collateral,
        uint256 amount,
        uint8[] calldata picks,
        address referrer,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        (uint128 picksMask, uint256 reservation) = _validateAndReserve(collateral, amount, picks);
        if (isFreeBet) {
            core.useFreeBet(msg.sender, collateral, amount);
        } else {
            core.pullFromUser(msg.sender, collateral, amount);
        }
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);
        core.reserveOrRevert(collateral, reservation);
        requestId = core.requestRandomWords(1);
        betId = nextBetId++;
        _writeBet(betId, requestId, collateral, amount, uint8(picks.length), picksMask, reservation, isFreeBet);
        emit BetPlaced(betId, requestId, msg.sender, collateral, amount, uint8(picks.length), picksMask);
    }

    function _validateAndReserve(
        address collateral,
        uint256 amount,
        uint8[] calldata picks
    ) internal view returns (uint128 picksMask, uint256 reservation) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        uint256 picksLen = picks.length;
        if (picksLen < MIN_PICKS || picksLen > MAX_PICKS) revert InvalidPicks();
        picksMask = _picksToMask(picks); // enforces sorted+unique+range
        uint256 amountUsd = core.getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD || amountUsd > MAX_BET_USD) revert InvalidAmount();
        if ((amountUsd * (MAX_MULTIPLIER_E18 - ONE)) / ONE > core.effectiveMaxProfitUsd(address(this))) {
            revert MaxProfitExceeded();
        }
        reservation = (amount * MAX_MULTIPLIER_E18) / ONE;
    }

    function _writeBet(
        uint256 betId,
        uint256 requestId,
        address collateral,
        uint256 amount,
        uint8 picksCount,
        uint128 picksMask,
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
        b.picksMask = picksMask;
        b.picksCount = picksCount;
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
        if (b.requestId != 0) delete requestIdToBetId[b.requestId];
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

        uint128 drawnMask = _drawNumbers(randomWords[0]);
        uint8 hits = _popcount128(drawnMask & b.picksMask);
        uint256 mult = paytables[b.picksCount][hits];
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

        b.drawnMask = drawnMask;
        b.hits = hits;
        b.multiplierE18 = mult;
        b.payout = payout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(betId, b.requestId, b.user, drawnMask, hits, mult, payout);
    }

    /* ========== RNG: DRAW 20 UNIQUE FROM 80 ========== */

    /// @notice Partial Fisher-Yates over a notional [1..80] deck. We need 20 swaps, consuming
    /// 20 × 16 = 320 bits. The first 256-bit VRF word gives 16 chunks; once exhausted, we
    /// re-hash the cursor for the remaining 4 swaps. Max bias per swap on `remaining ∈ [60, 80]`
    /// is ≤ 16/65536 ≈ 0.024%, well below industry standard
    function _drawNumbers(uint256 word) internal pure returns (uint128 mask) {
        uint8[POOL_SIZE] memory deck;
        for (uint8 i; i < POOL_SIZE; ++i) {
            deck[i] = i + 1; // numbers 1..80
        }
        uint256 cursor = word;
        uint8 chunksLeft = CHUNKS_PER_WORD;
        for (uint8 i; i < DRAW_COUNT; ++i) {
            if (chunksLeft == 0) {
                cursor = uint256(keccak256(abi.encode(cursor)));
                chunksLeft = CHUNKS_PER_WORD;
            }
            uint256 remaining = uint256(POOL_SIZE - i);
            uint256 j = uint256(i) + ((cursor & SHUFFLE_SHIFT_MASK) % remaining);
            cursor >>= SHUFFLE_SHIFT_BITS;
            --chunksLeft;
            uint8 tmp = deck[i];
            deck[i] = deck[uint8(j)];
            deck[uint8(j)] = tmp;
        }
        for (uint8 i; i < DRAW_COUNT; ++i) {
            mask |= uint128(1) << (deck[i] - 1);
        }
    }

    /// @notice Validates picks are sorted ascending, unique, and in [1, 80]. Returns bitmask
    function _picksToMask(uint8[] calldata picks) internal pure returns (uint128 mask) {
        uint8 prev;
        for (uint256 i; i < picks.length; ++i) {
            uint8 n = picks[i];
            if (n < 1 || n > POOL_SIZE) revert InvalidPicks();
            if (i > 0 && n <= prev) revert InvalidPicks(); // enforces ascending + unique
            mask |= uint128(1) << (n - 1);
            prev = n;
        }
    }

    /// @dev Brian Kernighan's bit-counting trick. 20 picks max → at most 20 iterations
    function _popcount128(uint128 x) internal pure returns (uint8 c) {
        while (x != 0) {
            x &= x - 1;
            ++c;
        }
    }

    /* ========== ADMIN: PAYTABLE MANAGEMENT ========== */

    /// @notice Owner can replace a paytable. `multipliers` length must equal picksCount + 1
    function setPaytable(uint8 picksCount, uint256[] calldata multipliers) external onlyOwner {
        if (picksCount < MIN_PICKS || picksCount > MAX_PICKS) revert InvalidPicks();
        if (multipliers.length != uint256(picksCount) + 1) revert PaytableLengthMismatch();
        for (uint256 i; i < multipliers.length; ++i) {
            if (multipliers[i] > MAX_MULTIPLIER_E18) revert MultiplierTooHigh();
        }
        delete paytables[picksCount];
        for (uint256 i; i < multipliers.length; ++i) {
            paytables[picksCount].push(multipliers[i]);
        }
        emit PaytableUpdated(picksCount, multipliers);
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
            uint8 picksCount,
            uint8 hits,
            uint128 picksMask,
            uint128 drawnMask,
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
            b.picksCount,
            b.hits,
            b.picksMask,
            b.drawnMask,
            b.multiplierE18
        );
    }

    function getPaytable(uint8 picksCount) external view override returns (uint256[] memory) {
        return paytables[picksCount];
    }

    function getMaxMultiplierE18() external pure override returns (uint256) {
        return MAX_MULTIPLIER_E18;
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

    /* ========== INTERNAL: array literal helpers (Solidity quirk) ========== */

    function _arr2(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _arr3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _arr4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory r) {
        r = new uint256[](4);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
    }

    function _arr5(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) internal pure returns (uint256[] memory r) {
        r = new uint256[](5);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
    }

    function _arr6(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f
    ) internal pure returns (uint256[] memory r) {
        r = new uint256[](6);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
        r[5] = f;
    }

    function _arr7(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g
    ) internal pure returns (uint256[] memory r) {
        r = new uint256[](7);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
        r[5] = f;
        r[6] = g;
    }

    function _arr8(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g,
        uint256 h
    ) internal pure returns (uint256[] memory r) {
        r = new uint256[](8);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
        r[5] = f;
        r[6] = g;
        r[7] = h;
    }

    function _arr9(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g,
        uint256 h,
        uint256 i
    ) internal pure returns (uint256[] memory r) {
        r = new uint256[](9);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
        r[5] = f;
        r[6] = g;
        r[7] = h;
        r[8] = i;
    }

    function _arr10(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g,
        uint256 h,
        uint256 i,
        uint256 j
    ) internal pure returns (uint256[] memory r) {
        r = new uint256[](10);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
        r[5] = f;
        r[6] = g;
        r[7] = h;
        r[8] = i;
        r[9] = j;
    }

    function _arr11(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g,
        uint256 h,
        uint256 i,
        uint256 j,
        uint256 k
    ) internal pure returns (uint256[] memory r) {
        r = new uint256[](11);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
        r[5] = f;
        r[6] = g;
        r[7] = h;
        r[8] = i;
        r[9] = j;
        r[10] = k;
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
