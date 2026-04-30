// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";

import "../../interfaces/ICasinoRoulette.sol";
import "../../interfaces/ICasinoBlackjack.sol";
import "../../interfaces/ICasinoDice.sol";
import "../../interfaces/ICasinoBaccarat.sol";
import "../../interfaces/ICasinoSlots.sol";

/// @title CasinoData
/// @author Overtime
/// @notice Read-only aggregator that merges paginated bet history across all five casino games
/// into a single uniform `BetRecord` shape, so frontends can fetch per-page history with one
/// eth_call per page instead of one call per bet
contract CasinoData is Initializable, ProxyOwned {
    /* ========== CONSTANTS ========== */

    /// @dev Status values for Roulette / Dice / Baccarat / Slots
    uint8 private constant STD_STATUS_RESOLVED = 2;
    uint8 private constant STD_STATUS_CANCELLED = 3;

    /// @dev Status values for Blackjack (HandStatus enum has play-state slots interleaved)
    uint8 private constant BJ_STATUS_RESOLVED = 6;
    uint8 private constant BJ_STATUS_CANCELLED = 7;

    /// @dev Blackjack HandResult values that count as a player win
    uint8 private constant BJ_RESULT_PLAYER_BLACKJACK = 1;
    uint8 private constant BJ_RESULT_PLAYER_WIN = 2;
    uint8 private constant BJ_RESULT_PUSH = 4;
    uint8 private constant BJ_RESULT_DEALER_BUST = 6;

    /// @dev Caps on returndata size for the per-game "full" readers
    uint private constant MAX_PAGE_LIMIT = 200;
    uint private constant MAX_BATCH_IDS = 100;

    /* ========== ENUMS ========== */

    /// @notice Canonical game identifier shared with the frontend
    enum Game {
        Roulette,
        Blackjack,
        Dice,
        Baccarat,
        Slots
    }

    /* ========== STRUCTS ========== */

    /// @notice Uniform per-bet shape produced by the aggregator
    /// @dev Blackjack splits expand into two records (one per hand) sharing user/collateral/isFreeBet.
    /// Hand 1 uses (base.amount, base.payout - payout2, base.result); hand 2 uses (amount2, payout2, result2)
    struct BetRecord {
        address user;
        address collateral;
        uint amount;
        uint payout;
        bool won;
        bool resolved;
        bool cancelled;
        bool isPush;
        bool isFreeBet;
    }

    /* ----- Per-game "full" record shapes -----
     *
     * One record per primary entity (no split-hand expansion). These are what the casino history
     * UI iterates: each record carries the financials plus the game-specific fields needed to
     * render a row (cards / reels / wheel result / picks / etc.). For PnL aggregation use the
     * `BetRecord`-based methods above; those still split-expand Blackjack and must keep that shape.
     */

    /// @notice Per-pick subrecord for Roulette. `reservedProfit` from the underlying contract is
    /// internal accounting and is intentionally dropped here
    struct RoulettePick {
        uint8 betType;
        uint8 selection;
        bool won;
        uint amount;
        uint payout;
    }

    /// @notice One record per Roulette betId. `result` is the wheel number (0..36).
    /// `primaryBetType` / `primarySelection` mirror picks[0] for single-pick rendering convenience
    struct RouletteFullRecord {
        uint betId;
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint placedAt;
        bool resolved;
        bool cancelled;
        bool won;
        bool isFreeBet;
        uint8 result;
        uint8 primaryBetType;
        uint8 primarySelection;
        RoulettePick[] picks;
    }

    /// @notice One record per Blackjack handId. NOT split-expanded — `*2` fields carry hand 2.
    /// Frontend decodes `status` (HandStatus) and `result` / `result2` (HandResult) directly
    struct BlackjackFullRecord {
        uint handId;
        address user;
        address collateral;
        uint amount;
        uint amount2;
        uint payout;
        uint placedAt;
        uint lastRequestAt;
        uint8 status;
        uint8 result;
        uint8 result2;
        bool isSplit;
        bool isDoubledDown;
        bool isDoubled2;
        bool isFreeBet;
        uint8[] playerCards;
        uint8[] dealerCards;
        uint8[] player2Cards;
    }

    /// @notice One record per Dice betId
    struct DiceFullRecord {
        uint betId;
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint placedAt;
        bool resolved;
        bool cancelled;
        bool won;
        bool isFreeBet;
        uint8 betType;
        uint8 target;
        uint8 result;
    }

    /// @notice One record per Baccarat betId. `cards` keeps slot semantics: indices 0..3 are the
    /// initial deal; index 4 is the player's optional 3rd card (0 if none); index 5 is the
    /// banker's optional 3rd card (0 if none)
    struct BaccaratFullRecord {
        uint betId;
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint placedAt;
        bool resolved;
        bool cancelled;
        bool won;
        bool isPush;
        bool isFreeBet;
        uint8 betType;
        uint8 playerTotal;
        uint8 bankerTotal;
        uint8[6] cards;
    }

    /// @notice One record per Slots spinId
    struct SlotsFullRecord {
        uint spinId;
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint placedAt;
        bool resolved;
        bool cancelled;
        bool won;
        bool isFreeBet;
        uint8[3] reels;
    }

    /* ========== STATE VARIABLES ========== */

    /// @notice Roulette game contract address. Zero means not deployed on this chain
    address public roulette;
    /// @notice Blackjack game contract address. Zero means not deployed on this chain
    address public blackjack;
    /// @notice Dice game contract address. Zero means not deployed on this chain
    address public dice;
    /// @notice Baccarat game contract address. Zero means not deployed on this chain
    address public baccarat;
    /// @notice Slots game contract address. Zero means not deployed on this chain
    address public slots;

    /* ========== EVENTS ========== */

    event GameAddressChanged(Game indexed game, address gameContract);

    /* ========== INITIALIZER ========== */

    /// @notice Initializes the aggregator with the five game addresses. Any of the five may be
    /// passed as the zero address if the game is not yet deployed on the current chain
    function initialize(
        address _owner,
        address _roulette,
        address _blackjack,
        address _dice,
        address _baccarat,
        address _slots
    ) external initializer {
        setOwner(_owner);
        roulette = _roulette;
        blackjack = _blackjack;
        dice = _dice;
        baccarat = _baccarat;
        slots = _slots;
    }

    /* ========== PUBLIC / EXTERNAL VIEW METHODS ========== */

    /// @notice Returns the next id the underlying game would assign. Useful for paging from the
    /// most recent bet down. Returns zero if the game is not wired
    function getNextId(Game game) external view returns (uint) {
        address a = _gameAddress(game);
        if (a == address(0)) return 0;
        if (game == Game.Roulette) return ICasinoRoulette(a).nextBetId();
        if (game == Game.Blackjack) return ICasinoBlackjack(a).nextHandId();
        if (game == Game.Dice) return ICasinoDice(a).nextBetId();
        if (game == Game.Baccarat) return ICasinoBaccarat(a).nextBetId();
        return ICasinoSlots(a).nextSpinId();
    }

    /// @notice Returns the most recent bets for a single game, in reverse chronological order.
    /// Returns an empty array if the game is not wired on this chain
    /// @dev For `Game.Blackjack` the returned array length may be up to `2 * limit` because each
    /// split hand expands into two `BetRecord`s. Other games return at most `limit` records
    function getRecentBets(Game game, uint offset, uint limit) external view returns (BetRecord[] memory) {
        return _recentBets(game, offset, limit);
    }

    /// @notice Returns one user's bets for a single game, in reverse chronological order.
    /// Same split-expansion semantics as `getRecentBets`
    function getUserBets(Game game, address user, uint offset, uint limit) external view returns (BetRecord[] memory) {
        return _userBets(game, user, offset, limit);
    }

    /// @notice Convenience reader returning recent bets for all five games in one call. Each
    /// inner array follows the same split-expansion rules as `getRecentBets`. The result is
    /// indexed by the `Game` enum (e.g. `out[uint(Game.Blackjack)]`)
    function getRecentBetsAllGames(uint offsetPerGame, uint limit) external view returns (BetRecord[][5] memory out) {
        out[uint(Game.Roulette)] = _recentBets(Game.Roulette, offsetPerGame, limit);
        out[uint(Game.Blackjack)] = _recentBets(Game.Blackjack, offsetPerGame, limit);
        out[uint(Game.Dice)] = _recentBets(Game.Dice, offsetPerGame, limit);
        out[uint(Game.Baccarat)] = _recentBets(Game.Baccarat, offsetPerGame, limit);
        out[uint(Game.Slots)] = _recentBets(Game.Slots, offsetPerGame, limit);
    }

    /* ========== INTERNAL ========== */

    function _recentBets(Game game, uint offset, uint limit) internal view returns (BetRecord[] memory) {
        address a = _gameAddress(game);
        if (a == address(0)) return new BetRecord[](0);
        uint[] memory ids = _recentIds(game, a, offset, limit);
        return _aggregate(game, a, ids);
    }

    function _userBets(Game game, address user, uint offset, uint limit) internal view returns (BetRecord[] memory) {
        address a = _gameAddress(game);
        if (a == address(0)) return new BetRecord[](0);
        uint[] memory ids = _userIds(game, a, user, offset, limit);
        return _aggregate(game, a, ids);
    }

    function _recentIds(Game game, address a, uint offset, uint limit) internal view returns (uint[] memory) {
        if (game == Game.Roulette) return ICasinoRoulette(a).getRecentBetIds(offset, limit);
        if (game == Game.Blackjack) return ICasinoBlackjack(a).getRecentHandIds(offset, limit);
        if (game == Game.Dice) return ICasinoDice(a).getRecentBetIds(offset, limit);
        if (game == Game.Baccarat) return ICasinoBaccarat(a).getRecentBetIds(offset, limit);
        return ICasinoSlots(a).getRecentSpinIds(offset, limit);
    }

    function _userIds(Game game, address a, address user, uint offset, uint limit) internal view returns (uint[] memory) {
        if (game == Game.Roulette) return ICasinoRoulette(a).getUserBetIds(user, offset, limit);
        if (game == Game.Blackjack) return ICasinoBlackjack(a).getUserHandIds(user, offset, limit);
        if (game == Game.Dice) return ICasinoDice(a).getUserBetIds(user, offset, limit);
        if (game == Game.Baccarat) return ICasinoBaccarat(a).getUserBetIds(user, offset, limit);
        return ICasinoSlots(a).getUserSpinIds(user, offset, limit);
    }

    /// @dev Pre-allocates 2*n entries for Blackjack to fit splits, then trims via mstore
    function _aggregate(Game game, address a, uint[] memory ids) internal view returns (BetRecord[] memory out) {
        uint n = ids.length;
        uint cap = game == Game.Blackjack ? n * 2 : n;
        out = new BetRecord[](cap);
        uint cursor;
        for (uint i; i < n; ++i) {
            uint id = ids[i];
            if (game == Game.Roulette) {
                out[cursor] = _readRoulette(ICasinoRoulette(a), id);
                ++cursor;
            } else if (game == Game.Blackjack) {
                cursor = _appendBlackjack(ICasinoBlackjack(a), id, out, cursor);
            } else if (game == Game.Dice) {
                out[cursor] = _readDice(ICasinoDice(a), id);
                ++cursor;
            } else if (game == Game.Baccarat) {
                out[cursor] = _readBaccarat(ICasinoBaccarat(a), id);
                ++cursor;
            } else {
                out[cursor] = _readSlots(ICasinoSlots(a), id);
                ++cursor;
            }
        }
        if (cursor < cap) {
            assembly {
                mstore(out, cursor)
            }
        }
    }

    function _readRoulette(ICasinoRoulette r, uint id) internal view returns (BetRecord memory rec) {
        (address user, address collateral, uint amount, uint payout, , , , ) = r.getBetBase(id);
        (, uint8 status, , bool won) = r.getBetDetails(id);
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won;
        rec.isFreeBet = r.isFreeBet(id);
    }

    function _readDice(ICasinoDice d, uint id) internal view returns (BetRecord memory rec) {
        (address user, address collateral, uint amount, uint payout, , , , ) = d.getBetBase(id);
        (, uint8 status, , , bool won) = d.getBetDetails(id);
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won;
        rec.isFreeBet = d.isFreeBet(id);
    }

    function _readBaccarat(ICasinoBaccarat b, uint id) internal view returns (BetRecord memory rec) {
        (address user, address collateral, uint amount, uint payout, , , , ) = b.getBetBase(id);
        (, uint8 status, , bool won, bool isPush, , , ) = b.getBetDetails(id);
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won && !isPush;
        rec.isPush = isPush;
        rec.isFreeBet = b.isFreeBet(id);
    }

    function _readSlots(ICasinoSlots s, uint id) internal view returns (BetRecord memory rec) {
        (address user, address collateral, uint amount, uint payout, , , , ) = s.getSpinBase(id);
        (uint8 status, , bool won) = s.getSpinDetails(id);
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won;
        rec.isFreeBet = s.isFreeBet(id);
    }

    /// @dev Writes one record for an unsplit hand or two records for a split hand. Hand 1 uses
    /// (base.amount, base.payout - payout2, base.result); hand 2 uses (amount2, payout2, result2).
    /// Both records share user/collateral/cancelled/resolved/isFreeBet
    function _appendBlackjack(
        ICasinoBlackjack b,
        uint id,
        BetRecord[] memory out,
        uint cursor
    ) internal view returns (uint) {
        BetRecord memory base = _readBlackjackBase(b, id);
        if (b.isSplit(id)) {
            (uint amount2, uint payout2, uint8 result2) = _readSplitFields(b, id);
            out[cursor] = _buildHandOne(base, payout2);
            ++cursor;
            out[cursor] = _buildHandTwo(base, amount2, payout2, result2);
            ++cursor;
        } else {
            out[cursor] = base;
            ++cursor;
        }
        return cursor;
    }

    /// @dev Reads core hand fields and packs them into a `BetRecord`. For an unsplit hand this is
    /// the final record; for a split hand, the split builders below derive hand 1 / hand 2 from it.
    /// `won` / `isPush` are encoded against the parent `result` and become per-hand on splits
    function _readBlackjackBase(ICasinoBlackjack b, uint id) internal view returns (BetRecord memory rec) {
        (address user, address collateral, uint amount, uint payout, , , , ) = b.getHandBase(id);
        (uint8 status, uint8 result, , , ) = b.getHandDetails(id);
        bool resolved = status == BJ_STATUS_RESOLVED;
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.resolved = resolved;
        rec.cancelled = status == BJ_STATUS_CANCELLED;
        rec.won = resolved && _isBlackjackWin(result);
        rec.isPush = resolved && result == BJ_RESULT_PUSH;
        rec.isFreeBet = b.isFreeBet(id);
    }

    /// @dev Pulls only the split fields we use, isolating the 8-tuple destructure to keep the
    /// caller's stack shallow
    function _readSplitFields(
        ICasinoBlackjack b,
        uint id
    ) internal view returns (uint amount2, uint payout2, uint8 result2) {
        (uint a2, uint p2, , , , , uint8 r2, ) = b.getSplitDetails(id);
        return (a2, p2, r2);
    }

    function _buildHandOne(BetRecord memory base, uint payout2) internal pure returns (BetRecord memory rec) {
        rec = base;
        rec.payout = base.payout - payout2;
    }

    function _buildHandTwo(
        BetRecord memory base,
        uint amount2,
        uint payout2,
        uint8 result2
    ) internal pure returns (BetRecord memory rec) {
        rec.user = base.user;
        rec.collateral = base.collateral;
        rec.amount = amount2;
        rec.payout = payout2;
        rec.resolved = base.resolved;
        rec.cancelled = base.cancelled;
        rec.won = base.resolved && _isBlackjackWin(result2);
        rec.isPush = base.resolved && result2 == BJ_RESULT_PUSH;
        rec.isFreeBet = base.isFreeBet;
    }

    function _isBlackjackWin(uint8 result) internal pure returns (bool) {
        return result == BJ_RESULT_PLAYER_BLACKJACK || result == BJ_RESULT_PLAYER_WIN || result == BJ_RESULT_DEALER_BUST;
    }

    function _gameAddress(Game game) internal view returns (address) {
        if (game == Game.Roulette) return roulette;
        if (game == Game.Blackjack) return blackjack;
        if (game == Game.Dice) return dice;
        if (game == Game.Baccarat) return baccarat;
        return slots;
    }

    /* ========== PER-GAME FULL READERS ========== */

    /* ----- Roulette ----- */

    /// @notice Returns the most recent Roulette bets with full game-specific fields. One record
    /// per betId. `limit` is silently clamped to {MAX_PAGE_LIMIT}. Empty if Roulette is not wired
    function getRecentRouletteBetsFull(uint offset, uint limit) external view returns (RouletteFullRecord[] memory) {
        address a = roulette;
        if (a == address(0)) return new RouletteFullRecord[](0);
        uint[] memory ids = ICasinoRoulette(a).getRecentBetIds(offset, _capLimit(limit));
        return _readRouletteBatch(a, ids);
    }

    /// @notice Returns one user's Roulette bets with full game-specific fields, paginated
    function getUserRouletteBetsFull(
        address user,
        uint offset,
        uint limit
    ) external view returns (RouletteFullRecord[] memory) {
        address a = roulette;
        if (a == address(0)) return new RouletteFullRecord[](0);
        uint[] memory ids = ICasinoRoulette(a).getUserBetIds(user, offset, _capLimit(limit));
        return _readRouletteBatch(a, ids);
    }

    /// @notice Returns Roulette bets for a caller-specified set of ids. Reverts if `ids.length`
    /// exceeds {MAX_BATCH_IDS}. Non-existent ids return zero-filled records (no revert)
    function getRouletteBetsByIds(uint[] memory ids) external view returns (RouletteFullRecord[] memory) {
        require(ids.length <= MAX_BATCH_IDS, "ids too long");
        address a = roulette;
        if (a == address(0)) return new RouletteFullRecord[](0);
        return _readRouletteBatch(a, ids);
    }

    function _readRouletteBatch(address a, uint[] memory ids) internal view returns (RouletteFullRecord[] memory out) {
        uint n = ids.length;
        out = new RouletteFullRecord[](n);
        for (uint i; i < n; ++i) out[i] = _readRouletteFull(a, ids[i]);
    }

    function _readRouletteFull(address a, uint id) internal view returns (RouletteFullRecord memory rec) {
        ICasinoRoulette r = ICasinoRoulette(a);
        (address user, address collateral, uint amount, uint payout, , uint placedAt, , ) = r.getBetBase(id);
        (ICasinoRoulette.Pick[] memory rawPicks, uint8 status, uint8 result, bool won) = r.getBetDetails(id);
        rec.betId = id;
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.placedAt = placedAt;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won;
        rec.isFreeBet = r.isFreeBet(id);
        rec.result = result;
        uint pn = rawPicks.length;
        if (pn > 0) {
            rec.primaryBetType = rawPicks[0].betType;
            rec.primarySelection = rawPicks[0].selection;
        }
        rec.picks = new RoulettePick[](pn);
        for (uint i; i < pn; ++i) {
            ICasinoRoulette.Pick memory p = rawPicks[i];
            rec.picks[i] = RoulettePick({
                betType: p.betType,
                selection: p.selection,
                won: p.won,
                amount: p.amount,
                payout: p.payout
            });
        }
    }

    /* ----- Blackjack (one record per handId, no split expansion) ----- */

    /// @notice Returns the most recent Blackjack hands with cards and split fields. One record
    /// per handId; split hand 2 fields are exposed as `*2` slots
    function getRecentBlackjackHandsFull(uint offset, uint limit) external view returns (BlackjackFullRecord[] memory) {
        address a = blackjack;
        if (a == address(0)) return new BlackjackFullRecord[](0);
        uint[] memory ids = ICasinoBlackjack(a).getRecentHandIds(offset, _capLimit(limit));
        return _readBlackjackBatch(a, ids);
    }

    /// @notice Returns one user's Blackjack hands with cards and split fields, paginated
    function getUserBlackjackHandsFull(
        address user,
        uint offset,
        uint limit
    ) external view returns (BlackjackFullRecord[] memory) {
        address a = blackjack;
        if (a == address(0)) return new BlackjackFullRecord[](0);
        uint[] memory ids = ICasinoBlackjack(a).getUserHandIds(user, offset, _capLimit(limit));
        return _readBlackjackBatch(a, ids);
    }

    /// @notice Returns Blackjack hands for a caller-specified set of ids
    function getBlackjackHandsByIds(uint[] memory ids) external view returns (BlackjackFullRecord[] memory) {
        require(ids.length <= MAX_BATCH_IDS, "ids too long");
        address a = blackjack;
        if (a == address(0)) return new BlackjackFullRecord[](0);
        return _readBlackjackBatch(a, ids);
    }

    function _readBlackjackBatch(address a, uint[] memory ids) internal view returns (BlackjackFullRecord[] memory out) {
        uint n = ids.length;
        out = new BlackjackFullRecord[](n);
        for (uint i; i < n; ++i) out[i] = _readBlackjackFull(a, ids[i]);
    }

    function _readBlackjackFull(address a, uint id) internal view returns (BlackjackFullRecord memory rec) {
        ICasinoBlackjack b = ICasinoBlackjack(a);
        rec.handId = id;
        _fillBlackjackBase(b, id, rec);
        _fillBlackjackDetails(b, id, rec);
        if (b.isSplit(id)) {
            _fillBlackjackSplit(b, id, rec);
        } else {
            rec.player2Cards = new uint8[](0);
        }
    }

    function _fillBlackjackBase(ICasinoBlackjack b, uint id, BlackjackFullRecord memory rec) internal view {
        (address user, address collateral, uint amount, uint payout, , uint placedAt, , ) = b.getHandBase(id);
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.placedAt = placedAt;
        rec.lastRequestAt = b.lastRequestAt(id);
        rec.isFreeBet = b.isFreeBet(id);
    }

    function _fillBlackjackDetails(ICasinoBlackjack b, uint id, BlackjackFullRecord memory rec) internal view {
        (uint8 status, uint8 result, bool isDoubledDown, , ) = b.getHandDetails(id);
        (uint8[] memory playerCards, uint8[] memory dealerCards) = b.getHandCards(id);
        rec.status = status;
        rec.result = result;
        rec.isDoubledDown = isDoubledDown;
        rec.playerCards = playerCards;
        rec.dealerCards = dealerCards;
    }

    function _fillBlackjackSplit(ICasinoBlackjack b, uint id, BlackjackFullRecord memory rec) internal view {
        (uint amount2, , , , , bool isDoubled2, uint8 result2, uint8[] memory player2Cards) = b.getSplitDetails(id);
        rec.isSplit = true;
        rec.amount2 = amount2;
        rec.result2 = result2;
        rec.isDoubled2 = isDoubled2;
        rec.player2Cards = player2Cards;
    }

    /* ----- Dice ----- */

    /// @notice Returns the most recent Dice bets with full game-specific fields
    function getRecentDiceBetsFull(uint offset, uint limit) external view returns (DiceFullRecord[] memory) {
        address a = dice;
        if (a == address(0)) return new DiceFullRecord[](0);
        uint[] memory ids = ICasinoDice(a).getRecentBetIds(offset, _capLimit(limit));
        return _readDiceBatch(a, ids);
    }

    /// @notice Returns one user's Dice bets with full game-specific fields
    function getUserDiceBetsFull(address user, uint offset, uint limit) external view returns (DiceFullRecord[] memory) {
        address a = dice;
        if (a == address(0)) return new DiceFullRecord[](0);
        uint[] memory ids = ICasinoDice(a).getUserBetIds(user, offset, _capLimit(limit));
        return _readDiceBatch(a, ids);
    }

    /// @notice Returns Dice bets for a caller-specified set of ids
    function getDiceBetsByIds(uint[] memory ids) external view returns (DiceFullRecord[] memory) {
        require(ids.length <= MAX_BATCH_IDS, "ids too long");
        address a = dice;
        if (a == address(0)) return new DiceFullRecord[](0);
        return _readDiceBatch(a, ids);
    }

    function _readDiceBatch(address a, uint[] memory ids) internal view returns (DiceFullRecord[] memory out) {
        uint n = ids.length;
        out = new DiceFullRecord[](n);
        for (uint i; i < n; ++i) out[i] = _readDiceFull(a, ids[i]);
    }

    function _readDiceFull(address a, uint id) internal view returns (DiceFullRecord memory rec) {
        ICasinoDice d = ICasinoDice(a);
        (address user, address collateral, uint amount, uint payout, , uint placedAt, , ) = d.getBetBase(id);
        (uint8 betType, uint8 status, uint8 target, uint8 result, bool won) = d.getBetDetails(id);
        rec.betId = id;
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.placedAt = placedAt;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won;
        rec.isFreeBet = d.isFreeBet(id);
        rec.betType = betType;
        rec.target = target;
        rec.result = result;
    }

    /* ----- Baccarat ----- */

    /// @notice Returns the most recent Baccarat bets with full game-specific fields
    function getRecentBaccaratBetsFull(uint offset, uint limit) external view returns (BaccaratFullRecord[] memory) {
        address a = baccarat;
        if (a == address(0)) return new BaccaratFullRecord[](0);
        uint[] memory ids = ICasinoBaccarat(a).getRecentBetIds(offset, _capLimit(limit));
        return _readBaccaratBatch(a, ids);
    }

    /// @notice Returns one user's Baccarat bets with full game-specific fields
    function getUserBaccaratBetsFull(
        address user,
        uint offset,
        uint limit
    ) external view returns (BaccaratFullRecord[] memory) {
        address a = baccarat;
        if (a == address(0)) return new BaccaratFullRecord[](0);
        uint[] memory ids = ICasinoBaccarat(a).getUserBetIds(user, offset, _capLimit(limit));
        return _readBaccaratBatch(a, ids);
    }

    /// @notice Returns Baccarat bets for a caller-specified set of ids
    function getBaccaratBetsByIds(uint[] memory ids) external view returns (BaccaratFullRecord[] memory) {
        require(ids.length <= MAX_BATCH_IDS, "ids too long");
        address a = baccarat;
        if (a == address(0)) return new BaccaratFullRecord[](0);
        return _readBaccaratBatch(a, ids);
    }

    function _readBaccaratBatch(address a, uint[] memory ids) internal view returns (BaccaratFullRecord[] memory out) {
        uint n = ids.length;
        out = new BaccaratFullRecord[](n);
        for (uint i; i < n; ++i) out[i] = _readBaccaratFull(a, ids[i]);
    }

    function _readBaccaratFull(address a, uint id) internal view returns (BaccaratFullRecord memory rec) {
        ICasinoBaccarat ba = ICasinoBaccarat(a);
        rec.betId = id;
        _fillBaccaratBase(ba, id, rec);
        _fillBaccaratDetails(ba, id, rec);
    }

    function _fillBaccaratBase(ICasinoBaccarat ba, uint id, BaccaratFullRecord memory rec) internal view {
        (address user, address collateral, uint amount, uint payout, , uint placedAt, , ) = ba.getBetBase(id);
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.placedAt = placedAt;
        rec.isFreeBet = ba.isFreeBet(id);
    }

    function _fillBaccaratDetails(ICasinoBaccarat ba, uint id, BaccaratFullRecord memory rec) internal view {
        (
            uint8 betType,
            uint8 status,
            ,
            bool won,
            bool isPush,
            uint8[6] memory cards,
            uint8 playerTotal,
            uint8 bankerTotal
        ) = ba.getBetDetails(id);
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won && !isPush;
        rec.isPush = isPush;
        rec.betType = betType;
        rec.playerTotal = playerTotal;
        rec.bankerTotal = bankerTotal;
        rec.cards = cards;
    }

    /* ----- Slots ----- */

    /// @notice Returns the most recent Slots spins with full game-specific fields
    function getRecentSlotsSpinsFull(uint offset, uint limit) external view returns (SlotsFullRecord[] memory) {
        address a = slots;
        if (a == address(0)) return new SlotsFullRecord[](0);
        uint[] memory ids = ICasinoSlots(a).getRecentSpinIds(offset, _capLimit(limit));
        return _readSlotsBatch(a, ids);
    }

    /// @notice Returns one user's Slots spins with full game-specific fields
    function getUserSlotsSpinsFull(address user, uint offset, uint limit) external view returns (SlotsFullRecord[] memory) {
        address a = slots;
        if (a == address(0)) return new SlotsFullRecord[](0);
        uint[] memory ids = ICasinoSlots(a).getUserSpinIds(user, offset, _capLimit(limit));
        return _readSlotsBatch(a, ids);
    }

    /// @notice Returns Slots spins for a caller-specified set of ids
    function getSlotsSpinsByIds(uint[] memory ids) external view returns (SlotsFullRecord[] memory) {
        require(ids.length <= MAX_BATCH_IDS, "ids too long");
        address a = slots;
        if (a == address(0)) return new SlotsFullRecord[](0);
        return _readSlotsBatch(a, ids);
    }

    function _readSlotsBatch(address a, uint[] memory ids) internal view returns (SlotsFullRecord[] memory out) {
        uint n = ids.length;
        out = new SlotsFullRecord[](n);
        for (uint i; i < n; ++i) out[i] = _readSlotsFull(a, ids[i]);
    }

    function _readSlotsFull(address a, uint id) internal view returns (SlotsFullRecord memory rec) {
        ICasinoSlots s = ICasinoSlots(a);
        (address user, address collateral, uint amount, uint payout, , uint placedAt, , ) = s.getSpinBase(id);
        (uint8 status, uint8[3] memory reels, bool won) = s.getSpinDetails(id);
        rec.spinId = id;
        rec.user = user;
        rec.collateral = collateral;
        rec.amount = amount;
        rec.payout = payout;
        rec.placedAt = placedAt;
        rec.resolved = status == STD_STATUS_RESOLVED;
        rec.cancelled = status == STD_STATUS_CANCELLED;
        rec.won = won;
        rec.isFreeBet = s.isFreeBet(id);
        rec.reels = reels;
    }

    function _capLimit(uint limit) internal pure returns (uint) {
        return limit > MAX_PAGE_LIMIT ? MAX_PAGE_LIMIT : limit;
    }

    /* ========== SETTERS ========== */

    /// @notice Sets the Roulette contract address. Pass address(0) to mark the game unwired
    function setRoulette(address _roulette) external onlyOwner {
        roulette = _roulette;
        emit GameAddressChanged(Game.Roulette, _roulette);
    }

    /// @notice Sets the Blackjack contract address. Pass address(0) to mark the game unwired
    function setBlackjack(address _blackjack) external onlyOwner {
        blackjack = _blackjack;
        emit GameAddressChanged(Game.Blackjack, _blackjack);
    }

    /// @notice Sets the Dice contract address. Pass address(0) to mark the game unwired
    function setDice(address _dice) external onlyOwner {
        dice = _dice;
        emit GameAddressChanged(Game.Dice, _dice);
    }

    /// @notice Sets the Baccarat contract address. Pass address(0) to mark the game unwired
    function setBaccarat(address _baccarat) external onlyOwner {
        baccarat = _baccarat;
        emit GameAddressChanged(Game.Baccarat, _baccarat);
    }

    /// @notice Sets the Slots contract address. Pass address(0) to mark the game unwired
    function setSlots(address _slots) external onlyOwner {
        slots = _slots;
        emit GameAddressChanged(Game.Slots, _slots);
    }
}
