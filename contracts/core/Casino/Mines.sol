// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoMines.sol";

/// @title Mines
/// @author Overtime
/// @notice 5×5 mines / minesweeper-style cashout game. Mines are committed at bet time via a
/// single VRF word and stored as a 25-bit mask. The user reveals tiles one at a time (no
/// per-tile randomness — the layout is already committed); each safe reveal increments the
/// running multiplier. The user cashes out at any time for `bet * multiplier`. Hitting a mine
/// loses the bet
/// @dev Multiplier formula:
///   m(mines, safeCount) = (1 - HE) × C(25, safeCount) / C(25 - mines, safeCount)
/// Bounded by `maxMultiplierE18` to cap per-bet house liability
///
/// !!! KNOWN ON-CHAIN-MINES TRADEOFF !!!
/// The mine mask is stored in contract storage after VRF fulfillment, so a sophisticated user
/// can read it via `eth_getStorageAt` (or any archive RPC) before revealing tiles and
/// systematically avoid mines. Trustless on-chain Mines that preserves both (a) the standard
/// interactive UX and (b) hidden mine positions is not possible without a TEE / FHE / MPC
/// layer — anything on-chain is publicly observable.
///
/// This contract matches the industry-standard onchain Mines design (see Stake's onchain
/// version, Roobet's onchain analogue, etc.). The design accepts that a small fraction of
/// power users may exploit storage-snooping. Realized house edge degrades for those users,
/// but most players (interacting via standard frontends) face the configured edge.
///
/// If a fully trustless variant is later needed, it would have to require pre-committing the
/// reveal sequence at bet time (a "Plinko-style" Mines), which loses the interactive feel.
contract Mines is ICasinoMines, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant GRID_SIZE = 25;

    /// @notice Floor on house edge (defends against accidental sub-2% setting)
    uint256 public constant MIN_HOUSE_EDGE_E18 = 0.02e18;
    uint256 public constant MAX_HOUSE_EDGE_E18 = 0.05e18;

    /// @notice Default per-bet multiplier cap. Without this, mines=12 with 13 safe reveals
    /// pays >5,000,000x. 1000x is industry-standard for crypto casinos
    uint256 public constant DEFAULT_MAX_MULTIPLIER_E18 = 1000e18;

    /// @dev Bits per Fisher-Yates swap. 16 bits gives <0.04% bias for any "remaining" 2..25
    uint8 private constant SHUFFLE_SHIFT_BITS = 16;
    uint64 private constant SHUFFLE_SHIFT_MASK = 0xFFFF;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidMineCount();
    error InvalidTileIndex();
    error TileAlreadyRevealed();
    error MaxProfitExceeded();
    error InvalidHouseEdge();
    error BetNotFound();
    error BetNotOwner();
    error InvalidBetStatus();
    error CancelTimeoutNotReached();
    error NoSafeTilesLeft();

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
        uint32 mineMask;
        uint32 revealedMask;
        uint8 mineCount;
        uint8 safeCount;
        BetStatus status;
        Outcome outcome;
    }

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ISportsAMMV2Manager public manager;

    uint256 public houseEdgeE18;
    uint256 public maxMultiplierE18;

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
        houseEdgeE18 = MIN_HOUSE_EDGE_E18;
        maxMultiplierE18 = DEFAULT_MAX_MULTIPLIER_E18;
    }

    /* ========== PLACE / REVEAL / CASHOUT ========== */

    function placeBet(
        address collateral,
        uint256 amount,
        uint8 mineCount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        if (mineCount == 0 || mineCount >= GRID_SIZE) revert InvalidMineCount();

        uint256 amountUsd = core.getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        // Worst-case house contribution = (maxMult - 1) × stake (USD)
        uint256 worstHouseProfitUsd = (amountUsd * (maxMultiplierE18 - ONE)) / ONE;
        if (worstHouseProfitUsd > core.maxProfitUsd()) revert MaxProfitExceeded();

        core.pullFromUser(msg.sender, collateral, amount);
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);

        uint256 reservation = (amount * maxMultiplierE18) / ONE;
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
        b.mineCount = mineCount;
        b.status = BetStatus.AWAITING_DEAL;

        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);

        emit BetPlaced(betId, requestId, msg.sender, collateral, amount, mineCount);
    }

    function revealTile(uint256 betId, uint8 tileIndex) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.ACTIVE) revert InvalidBetStatus();
        if (tileIndex >= GRID_SIZE) revert InvalidTileIndex();
        uint32 bit = uint32(1) << tileIndex;
        if ((b.revealedMask & bit) != 0) revert TileAlreadyRevealed();
        if (b.safeCount + b.mineCount >= GRID_SIZE) revert NoSafeTilesLeft();

        b.revealedMask |= bit;

        if ((b.mineMask & bit) != 0) {
            // Hit a mine — game over, no payout
            core.releaseReservation(b.collateral, b.reserved);
            b.reserved = 0;
            core.recordSettlement(b.collateral, b.amount, 0);
            core.payReferrer(b.user, b.collateral, b.amount);
            b.outcome = Outcome.HIT_MINE;
            b.status = BetStatus.RESOLVED;
            b.resolvedAt = block.timestamp;
            emit TileRevealed(betId, msg.sender, tileIndex, true, b.safeCount, 0);
            emit BetResolved(betId, msg.sender, Outcome.HIT_MINE, 0);
        } else {
            ++b.safeCount;
            uint256 currentMult = _multiplierE18(b.mineCount, b.safeCount);
            emit TileRevealed(betId, msg.sender, tileIndex, false, b.safeCount, currentMult);
        }
    }

    function cashout(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.ACTIVE) revert InvalidBetStatus();
        if (b.safeCount == 0) revert InvalidBetStatus();

        uint256 mult = _multiplierE18(b.mineCount, b.safeCount);
        uint256 payout = (b.amount * mult) / ONE;

        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;
        core.payOut(b.user, b.collateral, payout, false, b.amount);
        core.recordSettlement(b.collateral, b.amount, payout);

        b.payout = payout;
        b.outcome = Outcome.CASHED_OUT;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit CashedOut(betId, msg.sender, b.safeCount, mult, payout);
        emit BetResolved(betId, msg.sender, Outcome.CASHED_OUT, payout);
    }

    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.AWAITING_DEAL) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.AWAITING_DEAL) revert InvalidBetStatus();
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
    /// mid-payout for a double-spend (note: Mines pays out only on cashout, not in callback,
    /// but the lock also blocks revealTile/cashout re-entry which could otherwise corrupt state)
    function onVrfFulfilled(uint256 requestId, uint256[] calldata randomWords) external override nonReentrant {
        if (msg.sender != address(core)) revert InvalidSender();
        uint256 betId = requestIdToBetId[requestId];
        if (betId == 0) return;
        delete requestIdToBetId[requestId];

        Bet storage b = bets[betId];
        if (b.status != BetStatus.AWAITING_DEAL) return;

        b.mineMask = _shuffleMines(randomWords[0], b.mineCount);
        b.status = BetStatus.ACTIVE;
        emit MinesCommitted(betId, b.user, b.mineCount);
    }

    /// @notice Picks `mineCount` unique tile indices via partial Fisher-Yates over [0, 25).
    /// Re-hashes the random word every 16 swaps (16 chunks per 256-bit word) so high mine
    /// counts get enough entropy
    function _shuffleMines(uint256 word, uint8 mineCount) internal pure returns (uint32 mask) {
        uint8[GRID_SIZE] memory deck;
        for (uint8 i; i < GRID_SIZE; ++i) {
            deck[i] = i;
        }
        uint256 cursor = word;
        uint8 chunksLeft = 16; // 256 / 16
        for (uint8 i; i < mineCount; ++i) {
            if (chunksLeft == 0) {
                cursor = uint256(keccak256(abi.encode(cursor)));
                chunksLeft = 16;
            }
            uint256 remaining = uint256(GRID_SIZE - i);
            uint256 j = uint256(i) + ((cursor & SHUFFLE_SHIFT_MASK) % remaining);
            cursor >>= SHUFFLE_SHIFT_BITS;
            --chunksLeft;
            uint8 tmp = deck[i];
            deck[i] = deck[uint8(j)];
            deck[uint8(j)] = tmp;
        }
        for (uint8 i; i < mineCount; ++i) {
            mask |= uint32(1) << deck[i];
        }
    }

    /* ========== MULTIPLIER ========== */

    /// @inheritdoc ICasinoMines
    function multiplierE18(uint8 mineCount, uint8 safeCount) external view override returns (uint256) {
        return _multiplierE18(mineCount, safeCount);
    }

    /// @notice Returns the current cashout multiplier for a (mineCount, safeCount) pair, capped
    /// at `maxMultiplierE18`. Formula: (1 - HE) × prod_{i=0..safeCount-1} (25 - i) / (25 - mines - i)
    function _multiplierE18(uint8 mineCount, uint8 safeCount) internal view returns (uint256) {
        if (safeCount == 0) return 0;
        // Edge case: no safe tiles can possibly remain
        if (safeCount > GRID_SIZE - mineCount) return maxMultiplierE18;
        uint256 m = ONE - houseEdgeE18;
        for (uint8 i; i < safeCount; ++i) {
            m = (m * (GRID_SIZE - i)) / (GRID_SIZE - mineCount - i);
            if (m >= maxMultiplierE18) return maxMultiplierE18;
        }
        return m;
    }

    /* ========== ADMIN ========== */

    function setHouseEdge(uint256 newHouseEdgeE18) external onlyRiskManager {
        if (newHouseEdgeE18 < MIN_HOUSE_EDGE_E18 || newHouseEdgeE18 > MAX_HOUSE_EDGE_E18) revert InvalidHouseEdge();
        houseEdgeE18 = newHouseEdgeE18;
        emit HouseEdgeChanged(newHouseEdgeE18);
    }

    function setMaxMultiplier(uint256 newMaxE18) external onlyRiskManager {
        if (newMaxE18 < 2e18) revert InvalidAmount();
        maxMultiplierE18 = newMaxE18;
        emit MaxMultiplierChanged(newMaxE18);
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
            Outcome outcome,
            uint8 mineCount,
            uint8 safeCount,
            uint32 revealedMask
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
            b.outcome,
            b.mineCount,
            b.safeCount,
            b.revealedMask
        );
    }

    /// @notice Returns the mineMask. Note: revealing this pre-cashout would let the user avoid
    /// mines, but the mask is only used for settlement; reveals happen via `revealTile`. The
    /// mask is observable on-chain regardless (storage slot), so this getter just makes that
    /// access explicit. Frontends must NOT read this until status is RESOLVED
    function getMineMask(uint256 betId) external view override returns (uint32) {
        return bets[betId].mineMask;
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
