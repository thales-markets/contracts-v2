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
import "./CasinoHandsLib.sol";

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

    /// @notice Default minimum stake in USD (1e18 precision). Overridden when
    /// `core.effectiveMinBetUsd(keno)` is non-zero
    uint256 public constant MIN_BET_USD = 3e18;

    /// @notice Hard cap on any paytable entry. Per-bet liability = `bet × MAX_MULTIPLIER_E18`;
    /// `effectiveMaxProfitUsd(keno)` must clear that liability or `MaxProfitExceeded` reverts.
    /// To preserve the legacy $10 ceiling at deploy time, call
    /// `CasinoCoreV2.setMaxBetPerGameUsd(keno, 10e18)`
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
    error AboveMaxBet();
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
        // Remaining net-profit budget for this bet in collateral units. Sized at placeBet from
        // `effectiveMaxProfitUsd × price`, capped against the worst-case uncapped profit
        // (`amount × (MAX_MULTIPLIER - 1)`). Resolve truncates final payout to stake + this so
        // the per-bet house loss never exceeds the configured USD cap regardless of stake size.
        // Appended at end of struct for storage-safe upgrade
        uint256 profitCapRemaining;
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
    /// changes barely move RTP — most RTP comes from the 3–6 hit range.
    ///
    /// Implementation note: leading zero bands are left implicit — Solidity zero-initializes
    /// `new uint256[](n)`, so only the non-zero hit-count multipliers are assigned. Memory
    /// variable `m` is reassigned per pick (old allocation becomes unreachable but Solidity
    /// memory persists for the call; total transient cost is bounded and only paid once at init)
    function _setDefaultPaytables() internal {
        uint256[] memory m;
        // Pick 1:  RTP 98.000% (edge 2.000%)
        m = new uint256[](2);
        m[1] = (392 * ONE) / 100;
        _setDefault(1, m);
        // Pick 2:  RTP 98.101% (edge 1.899%)
        m = new uint256[](3);
        m[1] = ONE;
        m[2] = 10 * ONE;
        _setDefault(2, m);
        // Pick 3:  RTP 97.128% (edge 2.872%)
        m = new uint256[](4);
        m[2] = 2 * ONE;
        m[3] = 50 * ONE;
        _setDefault(3, m);
        // Pick 4:  RTP 97.668% (edge 2.332%)
        m = new uint256[](5);
        m[2] = ONE;
        m[3] = 12 * ONE;
        m[4] = 80 * ONE;
        _setDefault(4, m);
        // Pick 5:  RTP 97.290% (edge 2.710%)
        m = new uint256[](6);
        m[2] = ONE;
        m[3] = 3 * ONE;
        m[4] = 33 * ONE;
        m[5] = 80 * ONE;
        _setDefault(5, m);
        // Pick 6:  RTP 97.942% (edge 2.058%)
        m = new uint256[](7);
        m[2] = ONE;
        m[3] = 2 * ONE;
        m[4] = 8 * ONE;
        m[5] = 55 * ONE;
        m[6] = 100 * ONE;
        _setDefault(6, m);
        // Pick 7:  Top tier 250x (was 100x duplicate). Adds ~0.04% RTP — still ~3% edge
        m = new uint256[](8);
        m[3] = 2 * ONE;
        m[4] = 6 * ONE;
        m[5] = 27 * ONE;
        m[6] = 100 * ONE;
        m[7] = 250 * ONE;
        _setDefault(7, m);
        // Pick 8:  Top tier 300x (was 100x duplicate). Adds ~0.10% RTP — still ~2.2% edge
        m = new uint256[](9);
        m[3] = ONE;
        m[4] = 4 * ONE;
        m[5] = 18 * ONE;
        m[6] = 38 * ONE;
        m[7] = 100 * ONE;
        m[8] = 300 * ONE;
        _setDefault(8, m);
        // Pick 9:  Tail [150, 300] (was [100, 100]). Adds ~0.07% RTP — still ~2.4% edge
        m = new uint256[](10);
        m[3] = ONE;
        m[4] = 3 * ONE;
        m[5] = 7 * ONE;
        m[6] = 20 * ONE;
        m[7] = 70 * ONE;
        m[8] = 150 * ONE;
        m[9] = 300 * ONE;
        _setDefault(9, m);
        // Pick 10: Tail [100, 200, 300] (was [100, 100, 100]). Adds ~0.15% RTP — still ~2.9% edge
        m = new uint256[](11);
        m[3] = ONE;
        m[4] = 2 * ONE;
        m[5] = 4 * ONE;
        m[6] = 11 * ONE;
        m[7] = 38 * ONE;
        m[8] = 100 * ONE;
        m[9] = 200 * ONE;
        m[10] = 300 * ONE;
        _setDefault(10, m);
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
        (uint128 picksMask, uint256 reservation, uint256 cappedProfit) = _validateAndReserve(collateral, amount, picks);
        if (isFreeBet) {
            core.useFreeBet(msg.sender, collateral, amount);
        } else {
            core.pullFromUser(msg.sender, collateral, amount);
        }
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);
        core.reserveOrRevert(collateral, reservation);
        requestId = core.requestRandomWords(1);
        betId = nextBetId++;
        _writeBet(
            betId,
            requestId,
            collateral,
            amount,
            uint8(picks.length),
            picksMask,
            reservation,
            cappedProfit,
            isFreeBet
        );
        emit BetPlaced(betId, requestId, msg.sender, collateral, amount, uint8(picks.length), picksMask);
    }

    /// @notice Validates picks/size, computes the soft-truncated profit budget for this bet, and
    /// returns the reservation (stake + cappedProfit). Mirrors the 3CP/UTH/VideoPoker pattern:
    /// allow any bet size up to `effectiveMaxBetUsd`, then clamp the actual payout at resolve so
    /// the per-bet house loss never exceeds `effectiveMaxProfitUsd`. Previous behaviour
    /// hard-rejected at place time, which capped max bet at `cap / (MAX_MULTIPLIER - 1)` — only
    /// ~$3.34 under a $1000 cap with the 300× multiplier
    function _validateAndReserve(
        address collateral,
        uint256 amount,
        uint8[] calldata picks
    ) internal view returns (uint128 picksMask, uint256 reservation, uint256 cappedProfit) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        uint256 picksLen = picks.length;
        if (picksLen < MIN_PICKS || picksLen > MAX_PICKS) revert InvalidPicks();
        picksMask = _picksToMask(picks); // enforces sorted+unique+range
        _checkBetSize(collateral, amount);
        // Uncapped worst-case profit = amount × (MAX_MULTIPLIER - 1). Truncate to the per-game
        // USD profit cap (converted to collateral units). Used both for the reservation here
        // and as `profitCapRemaining` at resolve
        uint256 worst = (amount * (MAX_MULTIPLIER_E18 - ONE)) / ONE;
        uint256 capCollateral = core.collateralFromUsd(collateral, core.effectiveMaxProfitUsd(address(this)));
        cappedProfit = worst > capCollateral ? capCollateral : worst;
        // Reservation = stake-back + capped worst-case profit (matches max actual payout)
        reservation = amount + cappedProfit;
    }

    /// @notice Per-game bet-size gate. `core.effectiveMinBetUsd` / `effectiveMaxBetUsd` overrides
    /// (set via `CasinoCoreV2.setMinBetPerGameUsd` / `setMaxBetPerGameUsd`) take precedence; when
    /// unset (zero), `MIN_BET_USD` is the default floor and there is no explicit max ceiling —
    /// the per-bet house loss is then implicitly bounded by the profit-cap soft-truncation in
    /// `onVrfFulfilled`
    function _checkBetSize(address collateral, uint256 amount) internal view {
        uint256 amountUsd = core.getUsdValue(collateral, amount);
        uint256 minBet = core.effectiveMinBetUsd(address(this));
        if (minBet == 0) minBet = MIN_BET_USD;
        if (amountUsd < minBet) revert InvalidAmount();
        uint256 maxBet = core.effectiveMaxBetUsd(address(this));
        if (maxBet != 0 && amountUsd > maxBet) revert AboveMaxBet();
    }

    function _writeBet(
        uint256 betId,
        uint256 requestId,
        address collateral,
        uint256 amount,
        uint8 picksCount,
        uint128 picksMask,
        uint256 reservation,
        uint256 cappedProfit,
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
        b.profitCapRemaining = cappedProfit;
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
        // Decrement core's pending-stake counter (stake == refund → zero P&L impact)
        core.recordSettlement(b.collateral, b.amount, b.amount);
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
        uint8 hits = CasinoHandsLib.popcount(drawnMask & b.picksMask);
        uint256 mult = paytables[b.picksCount][hits];
        uint256 payout = (b.amount * mult) / ONE;

        // Soft-cap net profit at the per-bet budget. The paytable's top tier (Pick 8/9/10 at 300×)
        // can produce payouts well above the cap on large stakes; truncating here keeps the
        // per-bet house loss within `effectiveMaxProfitUsd` (matches 3CP/UTH/VideoPoker)
        if (payout > b.amount) {
            uint256 profit = payout - b.amount;
            if (profit > b.profitCapRemaining) profit = b.profitCapRemaining;
            payout = b.amount + profit;
            b.profitCapRemaining -= profit;
        }

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
    /// re-hash to extend. The rehash is keyed on the ORIGINAL `word` plus a salt counter — NOT
    /// the consumed cursor. After 16 chunks the cursor has been shifted right by exactly 256
    /// bits and equals zero, so `keccak256(abi.encode(cursor))` would be a compile-time
    /// constant and the last 4 swaps would sample fixed deck positions, breaking uniformity
    /// over C(80,20). Binding to `word` keeps every chunk dependent on the VRF output.
    /// Max bias per swap on `remaining ∈ [60, 80]` is ≤ 16/65536 ≈ 0.024%, well below
    /// industry standard
    function _drawNumbers(uint256 word) internal pure returns (uint128 mask) {
        uint8[POOL_SIZE] memory deck;
        for (uint8 i; i < POOL_SIZE; ++i) {
            deck[i] = i + 1; // numbers 1..80
        }
        uint256 cursor = word;
        uint8 chunksLeft = CHUNKS_PER_WORD;
        uint8 rehashes;
        for (uint8 i; i < DRAW_COUNT; ++i) {
            if (chunksLeft == 0) {
                ++rehashes;
                cursor = uint256(keccak256(abi.encode(word, rehashes)));
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

    /* ========== ADMIN: PAYTABLE MANAGEMENT ========== */

    /// @notice Owner can replace a paytable. `multipliers` length must equal picksCount + 1.
    /// @dev IN-FLIGHT BETS SEE THE NEW PAYTABLE. There is no per-bet snapshot. To avoid changing
    /// outcomes on bets already placed, pause the game (`setGamePaused` on core) and let all
    /// pending bets settle before calling this. The 2% house-edge floor and monotonicity are
    /// NOT enforced on-chain — verify off-chain (KenoEdgeSim.js) before submitting
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
        r.picksCount = b.picksCount;
        r.hits = b.hits;
        r.picksMask = b.picksMask;
        r.drawnMask = b.drawnMask;
        r.multiplierE18 = b.multiplierE18;
        r.isFreeBet = b.isFreeBet;
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

    /* ========== MODIFIERS ========== */

    function _requireRole(ISportsAMMV2Manager.Role role) internal view {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, role)) revert InvalidSender();
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
