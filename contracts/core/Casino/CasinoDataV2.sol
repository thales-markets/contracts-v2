// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";

import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoThreeCardPoker.sol";
import "../../interfaces/ICasinoPlinko.sol";
import "../../interfaces/ICasinoHiLo.sol";
import "../../interfaces/ICasinoKeno.sol";
import "../../interfaces/ICasinoOvertimeUltimateHoldem.sol";
import "../../interfaces/ICasinoVideoPoker.sol";
import "../../interfaces/ICasinoOvertimeBonusHoldem.sol";
import "../../interfaces/ICasinoDataV2.sol";

/// @title CasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator over `CasinoCoreV2` and the V2 casino games (ThreeCardPoker,
/// Plinko, HiLo, Keno, OvertimeUltimateHoldem, VideoPoker, OvertimeBonusHoldem). No state
/// writes, no funds.
/// Per-game readers forward to each game's own `getFullRecord` — the game owns its record shape
contract CasinoDataV2 is ICasinoDataV2, Initializable, ProxyOwned {
    /* ========== CONSTANTS ========== */

    uint256 private constant MAX_PAGE_LIMIT = 200;
    uint256 private constant MAX_BATCH_IDS = 100;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error LimitExceeded();

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ICasinoThreeCardPoker public threeCardPoker;
    ICasinoPlinko public plinko;
    ICasinoHiLo public hilo;
    ICasinoKeno public keno;
    ICasinoOvertimeUltimateHoldem public ultimateHoldem;
    ICasinoVideoPoker public videoPoker;
    ICasinoOvertimeBonusHoldem public bonusHoldem;

    uint256[32] private __gap;

    /* ========== INITIALIZER ========== */

    /// @notice Owner-only init. Core + every game slot is wired post-deploy via `setAddress`.
    /// Smaller initializer footprint (no per-game param plumbing); admin is trusted to wire
    /// the addresses before the contract is exposed to FE traffic
    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert InvalidAddress();
        setOwner(_owner);
    }

    /* ========== ADMIN ========== */

    /// @notice Unified address setter for Core + every wired game. Trusts the caller to pass a
    /// valid, non-zero address — no per-target zero check (we'd just emit InvalidAddress and the
    /// owner reattempts; with one consolidated path the savings beat the defensive cost). To
    /// "unwire" a game so the unwired-branches kick in, deploy a fresh data-contract impl
    /// @param target  Core if `target == GameV2.ThreeCardPoker` and `isCore == true`; otherwise
    ///                the GameV2 enum value identifies which game's slot to overwrite
    /// @param isCore  When true, writes to `core` regardless of `target`
    /// @param addr    The target address to wire in
    function setAddress(GameV2 target, bool isCore, address addr) external onlyOwner {
        if (isCore) {
            core = ICasinoCoreV2(addr);
            return;
        }
        if (target == GameV2.ThreeCardPoker) threeCardPoker = ICasinoThreeCardPoker(addr);
        else if (target == GameV2.Plinko) plinko = ICasinoPlinko(addr);
        else if (target == GameV2.HiLo) hilo = ICasinoHiLo(addr);
        else if (target == GameV2.Keno) keno = ICasinoKeno(addr);
        else if (target == GameV2.OvertimeUltimateHoldem) ultimateHoldem = ICasinoOvertimeUltimateHoldem(addr);
        else if (target == GameV2.VideoPoker) videoPoker = ICasinoVideoPoker(addr);
        else bonusHoldem = ICasinoOvertimeBonusHoldem(addr);
    }

    /* ========== TREASURY VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getTreasuryOverview(address[] calldata collaterals) external view override returns (TreasuryOverview memory o) {
        o.core = address(core);
        o.freeBetsHolder = core.freeBetsHolder();
        // ProxyPausable.paused() — accessible via the storage slot, but interface doesn't expose.
        // Skip for now; FE can query Core directly if it wants the global pause flag
        o.paused = false;
        o.maxProfitUsd = core.maxProfitUsd();
        o.cancelTimeout = core.cancelTimeout();
        o.defaultMaxNetLossPerGameUsd = 0; // not exposed on interface; skipped intentionally
        o.registeredGames = core.getRegisteredGames();

        uint256 n = collaterals.length;
        o.collaterals = collaterals;
        o.balancePerCollateral = new uint256[](n);
        o.reservedPerCollateral = new uint256[](n);
        o.availablePerCollateral = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address c = collaterals[i];
            o.reservedPerCollateral[i] = core.reservedProfitPerCollateral(c);
            o.availablePerCollateral[i] = core.getAvailableLiquidity(c);
            o.balancePerCollateral[i] = o.availablePerCollateral[i] + o.reservedPerCollateral[i];
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getGameStatus(
        address game,
        address[] calldata collaterals
    ) external view override returns (GameStatus memory s) {
        s.game = game;
        s.registered = core.isGameRegistered(game);
        s.paused = core.gamePaused(game);
        s.autoPaused = core.gameAutoPaused(game);
        s.houseNetUsd = core.houseNetUsd(game);
        s.maxNetLossUsd = core.maxNetLossPerGameUsd(game);
        uint256 n = collaterals.length;
        s.collaterals = collaterals;
        s.reservedPerCollateral = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            s.reservedPerCollateral[i] = core.reservedProfitPerGame(game, collaterals[i]);
        }
    }

    /* ========== PER-GAME RECORD DISPATCHERS ========== */
    /// @dev Each dispatcher fans the per-game branch into a single public entry. Returns are
    /// `bytes` wrapping the game's typed `FullRecord` (or `FullRecord[]`); the caller decodes
    /// per `GameV2` enum on its end. Trades typed Solidity return values for ~one shared entry
    /// per access shape, which shrinks the runtime dispatch table substantially

    /// @inheritdoc ICasinoDataV2
    function getFullRecord(GameV2 game, uint256 betId) external view override returns (bytes memory) {
        if (game == GameV2.ThreeCardPoker) return abi.encode(threeCardPoker.getFullRecord(betId));
        if (game == GameV2.Plinko) return abi.encode(plinko.getFullRecord(betId));
        if (game == GameV2.HiLo) return abi.encode(hilo.getFullRecord(betId));
        if (game == GameV2.Keno) return abi.encode(keno.getFullRecord(betId));
        if (game == GameV2.OvertimeUltimateHoldem) return abi.encode(ultimateHoldem.getFullRecord(betId));
        if (game == GameV2.VideoPoker) return abi.encode(videoPoker.getFullRecord(betId));
        return abi.encode(bonusHoldem.getFullRecord(betId));
    }

    /// @inheritdoc ICasinoDataV2
    function getFullRecords(GameV2 game, uint256[] calldata betIds) external view override returns (bytes memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _encodeRecordsByIds(game, betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserRecords(
        GameV2 game,
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (bytes memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _encodeRecordsByIds(game, _gameIface(game).getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentRecords(GameV2 game, uint256 offset, uint256 limit) external view override returns (bytes memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _encodeRecordsByIds(game, _gameIface(game).getRecentBetIds(offset, limit));
    }

    /// @dev Returns the right `ICasinoThreeCardPoker`-shaped interface for the requested game,
    /// using `ICasinoThreeCardPoker` as a structural stand-in (every V2 game shares the
    /// `getUserBetIds` / `getRecentBetIds` signatures). Per `casino_v2_fractional_reserve`
    /// design, all games are upgrade-safely registered on `CasinoCoreV2`; this just selects
    /// the relevant address
    function _gameIface(GameV2 game) internal view returns (ICasinoThreeCardPoker) {
        if (game == GameV2.ThreeCardPoker) return threeCardPoker;
        if (game == GameV2.Plinko) return ICasinoThreeCardPoker(address(plinko));
        if (game == GameV2.HiLo) return ICasinoThreeCardPoker(address(hilo));
        if (game == GameV2.Keno) return ICasinoThreeCardPoker(address(keno));
        if (game == GameV2.OvertimeUltimateHoldem) return ICasinoThreeCardPoker(address(ultimateHoldem));
        if (game == GameV2.VideoPoker) return ICasinoThreeCardPoker(address(videoPoker));
        return ICasinoThreeCardPoker(address(bonusHoldem));
    }

    function _encodeRecordsByIds(GameV2 game, uint256[] memory ids) internal view returns (bytes memory) {
        if (game == GameV2.ThreeCardPoker) {
            ICasinoThreeCardPoker.FullRecord[] memory out = new ICasinoThreeCardPoker.FullRecord[](ids.length);
            for (uint256 i; i < ids.length; ++i) out[i] = threeCardPoker.getFullRecord(ids[i]);
            return abi.encode(out);
        }
        if (game == GameV2.Plinko) {
            ICasinoPlinko.FullRecord[] memory out = new ICasinoPlinko.FullRecord[](ids.length);
            for (uint256 i; i < ids.length; ++i) out[i] = plinko.getFullRecord(ids[i]);
            return abi.encode(out);
        }
        if (game == GameV2.HiLo) {
            ICasinoHiLo.FullRecord[] memory out = new ICasinoHiLo.FullRecord[](ids.length);
            for (uint256 i; i < ids.length; ++i) out[i] = hilo.getFullRecord(ids[i]);
            return abi.encode(out);
        }
        if (game == GameV2.Keno) {
            ICasinoKeno.FullRecord[] memory out = new ICasinoKeno.FullRecord[](ids.length);
            for (uint256 i; i < ids.length; ++i) out[i] = keno.getFullRecord(ids[i]);
            return abi.encode(out);
        }
        if (game == GameV2.OvertimeUltimateHoldem) {
            ICasinoOvertimeUltimateHoldem.FullRecord[] memory out = new ICasinoOvertimeUltimateHoldem.FullRecord[](
                ids.length
            );
            for (uint256 i; i < ids.length; ++i) out[i] = ultimateHoldem.getFullRecord(ids[i]);
            return abi.encode(out);
        }
        if (game == GameV2.VideoPoker) {
            ICasinoVideoPoker.FullRecord[] memory out = new ICasinoVideoPoker.FullRecord[](ids.length);
            for (uint256 i; i < ids.length; ++i) out[i] = videoPoker.getFullRecord(ids[i]);
            return abi.encode(out);
        }
        ICasinoOvertimeBonusHoldem.FullRecord[] memory out2 = new ICasinoOvertimeBonusHoldem.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out2[i] = bonusHoldem.getFullRecord(ids[i]);
        return abi.encode(out2);
    }

    /* ========== CROSS-GAME ========== */

    /// @inheritdoc ICasinoDataV2
    /// @dev Merges the most-recent bets from every wired game for `user`, sorts by `placedAt`
    /// desc, returns the [offset, offset+limit) slice. Pulls `offset+limit` from each game and
    /// merge-sorts in memory — bounded by `6 * MAX_PAGE_LIMIT`
    function getUserRecentBetsV2(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (BetRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        BetRecord[] memory all = _gatherUserBets(user, offset + limit);
        uint256 total = all.length;

        // Insertion sort by placedAt desc — N is small in practice (bounded by 6*MAX_PAGE_LIMIT)
        // and this is a view call, so gas isn't the constraint
        for (uint256 i = 1; i < total; ++i) {
            BetRecord memory tmp = all[i];
            uint256 j = i;
            while (j > 0 && all[j - 1].placedAt < tmp.placedAt) {
                all[j] = all[j - 1];
                --j;
            }
            all[j] = tmp;
        }

        if (offset >= total) return new BetRecord[](0);
        uint256 remaining = total - offset;
        uint256 count = remaining < limit ? remaining : limit;
        out = new BetRecord[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = all[offset + i];
        }
    }

    /// @inheritdoc ICasinoDataV2
    /// @dev One inner array per game in `GameV2` enum order: [TCP, Plinko, HiLo, Keno,
    /// UltimateHoldem, VideoPoker, OvertimeBonusHoldem]
    function getRecentBetsAllGamesV2(
        uint256 offsetPerGame,
        uint256 limit
    ) external view override returns (BetRecord[][] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        out = new BetRecord[][](7);
        out[uint256(GameV2.ThreeCardPoker)] = _recentBaseRecords(
            address(threeCardPoker),
            offsetPerGame,
            limit,
            GameV2.ThreeCardPoker
        );
        out[uint256(GameV2.Plinko)] = _recentBaseRecords(address(plinko), offsetPerGame, limit, GameV2.Plinko);
        out[uint256(GameV2.HiLo)] = _recentBaseRecords(address(hilo), offsetPerGame, limit, GameV2.HiLo);
        out[uint256(GameV2.Keno)] = _recentBaseRecords(address(keno), offsetPerGame, limit, GameV2.Keno);
        out[uint256(GameV2.OvertimeUltimateHoldem)] = _recentBaseRecords(
            address(ultimateHoldem),
            offsetPerGame,
            limit,
            GameV2.OvertimeUltimateHoldem
        );
        out[uint256(GameV2.VideoPoker)] = _recentBaseRecords(address(videoPoker), offsetPerGame, limit, GameV2.VideoPoker);
        out[uint256(GameV2.OvertimeBonusHoldem)] = _recentBaseRecords(
            address(bonusHoldem),
            offsetPerGame,
            limit,
            GameV2.OvertimeBonusHoldem
        );
    }

    /// @inheritdoc ICasinoDataV2
    /// @dev Returns the game's `nextBetId` — total resolved+pending+cancelled bets is `nextBetId - 1`.
    /// Each game stores `nextBetId` starting at 1, so `nextBetId == 1` means no bets placed yet
    function getNextBetId(GameV2 game) external view override returns (uint256) {
        if (game == GameV2.ThreeCardPoker && address(threeCardPoker) != address(0)) return threeCardPoker.nextBetId();
        if (game == GameV2.Plinko && address(plinko) != address(0)) return plinko.nextBetId();
        if (game == GameV2.HiLo && address(hilo) != address(0)) return hilo.nextBetId();
        if (game == GameV2.Keno && address(keno) != address(0)) return keno.nextBetId();
        if (game == GameV2.OvertimeUltimateHoldem && address(ultimateHoldem) != address(0)) {
            return ultimateHoldem.nextBetId();
        }
        if (game == GameV2.VideoPoker && address(videoPoker) != address(0)) {
            return videoPoker.nextBetId();
        }
        if (game == GameV2.OvertimeBonusHoldem && address(bonusHoldem) != address(0)) {
            return bonusHoldem.nextBetId();
        }
        return 1; // game not wired yet
    }

    /* ========== INTERNAL: CROSS-GAME GATHER ========== */

    /// @dev Pulls up to `take` bet ids from each game for `user` and packs into a single
    /// BetRecord array. Split into primary/secondary/tertiary buckets to keep within Solidity's
    /// stack budget — each bucket holds at most 3-4 games' worth of local arrays
    function _gatherUserBets(address user, uint256 take) internal view returns (BetRecord[] memory all) {
        BetRecord[] memory a = _gatherPrimaryUserBets(user, take);
        BetRecord[] memory b = _gatherSecondaryUserBets(user, take);
        BetRecord[] memory c = _gatherTertiaryUserBets(user, take);
        all = new BetRecord[](a.length + b.length + c.length);
        uint256 k;
        for (uint256 i; i < a.length; ++i) all[k++] = a[i];
        for (uint256 i; i < b.length; ++i) all[k++] = b[i];
        for (uint256 i; i < c.length; ++i) all[k++] = c[i];
    }

    /// @dev TCP + Plinko + HiLo (always wired post-deploy). Split for stack budget
    function _gatherPrimaryUserBets(address user, uint256 take) internal view returns (BetRecord[] memory out) {
        uint256[] memory tcpIds = threeCardPoker.getUserBetIds(user, 0, take);
        uint256[] memory plinkoIds = plinko.getUserBetIds(user, 0, take);
        uint256[] memory hiloIds = hilo.getUserBetIds(user, 0, take);
        out = new BetRecord[](tcpIds.length + plinkoIds.length + hiloIds.length);
        uint256 k;
        for (uint256 i; i < tcpIds.length; ++i) out[k++] = _readTcpBase(tcpIds[i]);
        for (uint256 i; i < plinkoIds.length; ++i) out[k++] = _readPlinkoBase(plinkoIds[i]);
        for (uint256 i; i < hiloIds.length; ++i) out[k++] = _readHiLoBase(hiloIds[i]);
    }

    /// @dev Keno + UTH + VideoPoker (may be unwired). Split for stack budget
    function _gatherSecondaryUserBets(address user, uint256 take) internal view returns (BetRecord[] memory out) {
        uint256[] memory kenoIds = address(keno) != address(0) ? keno.getUserBetIds(user, 0, take) : new uint256[](0);
        uint256[] memory uthIds = address(ultimateHoldem) != address(0)
            ? ultimateHoldem.getUserBetIds(user, 0, take)
            : new uint256[](0);
        uint256[] memory vpIds = address(videoPoker) != address(0)
            ? videoPoker.getUserBetIds(user, 0, take)
            : new uint256[](0);
        out = new BetRecord[](kenoIds.length + uthIds.length + vpIds.length);
        uint256 k;
        for (uint256 i; i < kenoIds.length; ++i) out[k++] = _readKenoBase(kenoIds[i]);
        for (uint256 i; i < uthIds.length; ++i) out[k++] = _readUthBase(uthIds[i]);
        for (uint256 i; i < vpIds.length; ++i) out[k++] = _readVpBase(vpIds[i]);
    }

    /// @dev OvertimeBonusHoldem (may be unwired). Separate bucket so future games can slot in
    /// here without re-balancing primary/secondary stack budgets
    function _gatherTertiaryUserBets(address user, uint256 take) internal view returns (BetRecord[] memory out) {
        uint256[] memory bhIds = address(bonusHoldem) != address(0)
            ? bonusHoldem.getUserBetIds(user, 0, take)
            : new uint256[](0);
        out = new BetRecord[](bhIds.length);
        for (uint256 i; i < bhIds.length; ++i) out[i] = _readBonusHoldemBase(bhIds[i]);
    }

    /* ========== INTERNAL: RECENT BetRecord BUILDERS ========== */

    /// @dev Unified per-game recent BetRecord builder. Dispatches the per-game projection on
    /// `game` after fetching the ids. Returns an empty array if `gameAddr` is the zero address
    /// (game not wired yet — applies to keno/uth/vp pre-wire)
    function _recentBaseRecords(
        address gameAddr,
        uint256 offset,
        uint256 limit,
        GameV2 game
    ) internal view returns (BetRecord[] memory out) {
        if (gameAddr == address(0)) return new BetRecord[](0);
        // All six games share the same `getRecentBetIds` signature on their interface
        uint256[] memory ids = ICasinoThreeCardPoker(gameAddr).getRecentBetIds(offset, limit);
        out = new BetRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = _readBase(game, ids[i]);
    }

    /// @dev Single dispatcher to the per-game `_readXBase` projection. Keeps the recent-builder
    /// generic over `GameV2`
    function _readBase(GameV2 game, uint256 betId) internal view returns (BetRecord memory) {
        if (game == GameV2.ThreeCardPoker) return _readTcpBase(betId);
        if (game == GameV2.Plinko) return _readPlinkoBase(betId);
        if (game == GameV2.HiLo) return _readHiLoBase(betId);
        if (game == GameV2.Keno) return _readKenoBase(betId);
        if (game == GameV2.OvertimeUltimateHoldem) return _readUthBase(betId);
        if (game == GameV2.VideoPoker) return _readVpBase(betId);
        return _readBonusHoldemBase(betId);
    }

    /* ========== INTERNAL: PER-GAME BetRecord PROJECTION ========== */
    /// @dev Each per-game reader fetches its typed `FullRecord` (return types differ per game so
    /// the fetch can't be shared) and forwards the common scalar fields to `_packBase`. The
    /// projection (assignments + `won` computation) lives once in `_packBase`

    function _packBase(
        GameV2 game,
        uint256 betId,
        address user,
        address collateral,
        uint256 amount,
        uint256 payout,
        uint256 placedAt,
        bool resolved,
        bool cancelled
    ) internal pure returns (BetRecord memory b) {
        b.game = game;
        b.betId = betId;
        b.user = user;
        b.collateral = collateral;
        b.amount = amount;
        b.payout = payout;
        b.placedAt = placedAt;
        b.resolved = resolved;
        b.cancelled = cancelled;
        b.won = resolved && payout > amount;
    }

    function _readTcpBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoThreeCardPoker.FullRecord memory r = threeCardPoker.getFullRecord(betId);
        return
            _packBase(
                GameV2.ThreeCardPoker,
                betId,
                r.user,
                r.collateral,
                r.anteAmount + r.pairPlusAmount,
                r.totalPayout,
                r.placedAt,
                r.status == ICasinoThreeCardPoker.BetStatus.RESOLVED,
                r.status == ICasinoThreeCardPoker.BetStatus.CANCELLED
            );
    }

    function _readPlinkoBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoPlinko.FullRecord memory r = plinko.getFullRecord(betId);
        return
            _packBase(
                GameV2.Plinko,
                betId,
                r.user,
                r.collateral,
                r.amount,
                r.payout,
                r.placedAt,
                r.status == ICasinoPlinko.BetStatus.RESOLVED,
                r.status == ICasinoPlinko.BetStatus.CANCELLED
            );
    }

    function _readHiLoBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoHiLo.FullRecord memory r = hilo.getFullRecord(betId);
        return
            _packBase(
                GameV2.HiLo,
                betId,
                r.user,
                r.collateral,
                r.amount,
                r.payout,
                r.placedAt,
                r.status == ICasinoHiLo.BetStatus.RESOLVED,
                r.status == ICasinoHiLo.BetStatus.CANCELLED
            );
    }

    function _readKenoBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoKeno.FullRecord memory r = keno.getFullRecord(betId);
        return
            _packBase(
                GameV2.Keno,
                betId,
                r.user,
                r.collateral,
                r.amount,
                r.payout,
                r.placedAt,
                r.status == ICasinoKeno.BetStatus.RESOLVED,
                r.status == ICasinoKeno.BetStatus.CANCELLED
            );
    }

    function _readUthBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoOvertimeUltimateHoldem.FullRecord memory r = ultimateHoldem.getFullRecord(betId);
        return
            _packBase(
                GameV2.OvertimeUltimateHoldem,
                betId,
                r.user,
                r.collateral,
                r.anteAmount * 2 + r.playAmount,
                r.totalPayout,
                r.placedAt,
                r.status == ICasinoOvertimeUltimateHoldem.BetStatus.RESOLVED,
                r.status == ICasinoOvertimeUltimateHoldem.BetStatus.CANCELLED
            );
    }

    function _readVpBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoVideoPoker.FullRecord memory r = videoPoker.getFullRecord(betId);
        return
            _packBase(
                GameV2.VideoPoker,
                betId,
                r.user,
                r.collateral,
                r.amount,
                r.payout,
                r.placedAt,
                r.status == ICasinoVideoPoker.BetStatus.RESOLVED,
                r.status == ICasinoVideoPoker.BetStatus.CANCELLED
            );
    }

    function _readBonusHoldemBase(uint256 betId) internal view returns (BetRecord memory) {
        ICasinoOvertimeBonusHoldem.FullRecord memory r = bonusHoldem.getFullRecord(betId);
        return
            _packBase(
                GameV2.OvertimeBonusHoldem,
                betId,
                r.user,
                r.collateral,
                r.anteAmount, // primary stake; FE can sum legs from FullRecord if needed
                r.totalPayout,
                r.placedAt,
                r.status == ICasinoOvertimeBonusHoldem.BetStatus.RESOLVED,
                r.status == ICasinoOvertimeBonusHoldem.BetStatus.CANCELLED
            );
    }
}
