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
import "../../interfaces/ICasinoDataV2.sol";

/// @title CasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator over `CasinoCoreV2` and the V2 casino games (ThreeCardPoker,
/// Plinko, HiLo, Keno, OvertimeUltimateHoldem, VideoPoker). No state writes, no funds.
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

    uint256[33] private __gap;

    /* ========== INITIALIZER ========== */

    function initialize(address _owner, address _core, address _threeCardPoker) external initializer {
        if (_owner == address(0)) revert InvalidAddress();
        setOwner(_owner);
        if (_core != address(0)) core = ICasinoCoreV2(_core);
        if (_threeCardPoker != address(0)) threeCardPoker = ICasinoThreeCardPoker(_threeCardPoker);
    }

    /* ========== ADMIN ========== */

    function setCore(address _core) external onlyOwner {
        if (_core == address(0)) revert InvalidAddress();
        core = ICasinoCoreV2(_core);
    }

    function setThreeCardPoker(address _threeCardPoker) external onlyOwner {
        if (_threeCardPoker == address(0)) revert InvalidAddress();
        threeCardPoker = ICasinoThreeCardPoker(_threeCardPoker);
    }

    function setPlinko(address _plinko) external onlyOwner {
        if (_plinko == address(0)) revert InvalidAddress();
        plinko = ICasinoPlinko(_plinko);
    }

    function setHiLo(address _hilo) external onlyOwner {
        if (_hilo == address(0)) revert InvalidAddress();
        hilo = ICasinoHiLo(_hilo);
    }

    function setKeno(address _keno) external onlyOwner {
        if (_keno == address(0)) revert InvalidAddress();
        keno = ICasinoKeno(_keno);
    }

    function setUltimateHoldem(address _ultimateHoldem) external onlyOwner {
        if (_ultimateHoldem == address(0)) revert InvalidAddress();
        ultimateHoldem = ICasinoOvertimeUltimateHoldem(_ultimateHoldem);
    }

    function setVideoPoker(address _videoPoker) external onlyOwner {
        if (_videoPoker == address(0)) revert InvalidAddress();
        videoPoker = ICasinoVideoPoker(_videoPoker);
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

    /* ========== TCP VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getThreeCardPokerFullRecord(
        uint256 betId
    ) external view override returns (ICasinoThreeCardPoker.FullRecord memory) {
        return threeCardPoker.getFullRecord(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getThreeCardPokerFullRecords(
        uint256[] calldata betIds
    ) external view override returns (ICasinoThreeCardPoker.FullRecord[] memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _tcpRecordsByIds(betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserThreeCardPokerRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoThreeCardPoker.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _tcpRecordsByIds(threeCardPoker.getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentThreeCardPokerRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoThreeCardPoker.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _tcpRecordsByIds(threeCardPoker.getRecentBetIds(offset, limit));
    }

    function _tcpRecordsByIds(uint256[] memory ids) internal view returns (ICasinoThreeCardPoker.FullRecord[] memory out) {
        out = new ICasinoThreeCardPoker.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = threeCardPoker.getFullRecord(ids[i]);
    }

    /* ========== PLINKO VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getPlinkoFullRecord(uint256 betId) external view override returns (ICasinoPlinko.FullRecord memory) {
        return plinko.getFullRecord(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getPlinkoFullRecords(
        uint256[] calldata betIds
    ) external view override returns (ICasinoPlinko.FullRecord[] memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _plinkoRecordsByIds(betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserPlinkoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoPlinko.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _plinkoRecordsByIds(plinko.getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentPlinkoRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoPlinko.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _plinkoRecordsByIds(plinko.getRecentBetIds(offset, limit));
    }

    function _plinkoRecordsByIds(uint256[] memory ids) internal view returns (ICasinoPlinko.FullRecord[] memory out) {
        out = new ICasinoPlinko.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = plinko.getFullRecord(ids[i]);
    }

    /* ========== HI-LO VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getHiLoFullRecord(uint256 betId) external view override returns (ICasinoHiLo.FullRecord memory) {
        return hilo.getFullRecord(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getHiLoFullRecords(uint256[] calldata betIds) external view override returns (ICasinoHiLo.FullRecord[] memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _hiloRecordsByIds(betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserHiLoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoHiLo.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _hiloRecordsByIds(hilo.getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentHiLoRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoHiLo.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _hiloRecordsByIds(hilo.getRecentBetIds(offset, limit));
    }

    function _hiloRecordsByIds(uint256[] memory ids) internal view returns (ICasinoHiLo.FullRecord[] memory out) {
        out = new ICasinoHiLo.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = hilo.getFullRecord(ids[i]);
    }

    /* ========== KENO VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getKenoFullRecord(uint256 betId) external view override returns (ICasinoKeno.FullRecord memory) {
        return keno.getFullRecord(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getKenoFullRecords(uint256[] calldata betIds) external view override returns (ICasinoKeno.FullRecord[] memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _kenoRecordsByIds(betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserKenoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoKeno.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _kenoRecordsByIds(keno.getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentKenoRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoKeno.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _kenoRecordsByIds(keno.getRecentBetIds(offset, limit));
    }

    function _kenoRecordsByIds(uint256[] memory ids) internal view returns (ICasinoKeno.FullRecord[] memory out) {
        out = new ICasinoKeno.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = keno.getFullRecord(ids[i]);
    }

    /* ========== ULTIMATE HOLD'EM VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getOvertimeUltimateHoldemFullRecord(
        uint256 betId
    ) external view override returns (ICasinoOvertimeUltimateHoldem.FullRecord memory) {
        return ultimateHoldem.getFullRecord(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getOvertimeUltimateHoldemFullRecords(
        uint256[] calldata betIds
    ) external view override returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _uthRecordsByIds(betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserOvertimeUltimateHoldemRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _uthRecordsByIds(ultimateHoldem.getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentOvertimeUltimateHoldemRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _uthRecordsByIds(ultimateHoldem.getRecentBetIds(offset, limit));
    }

    function _uthRecordsByIds(
        uint256[] memory ids
    ) internal view returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory out) {
        out = new ICasinoOvertimeUltimateHoldem.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = ultimateHoldem.getFullRecord(ids[i]);
    }

    /* ========== VIDEO POKER VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getVideoPokerFullRecord(uint256 betId) external view override returns (ICasinoVideoPoker.FullRecord memory) {
        return videoPoker.getFullRecord(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getVideoPokerFullRecords(
        uint256[] calldata betIds
    ) external view override returns (ICasinoVideoPoker.FullRecord[] memory) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        return _vpRecordsByIds(betIds);
    }

    /// @inheritdoc ICasinoDataV2
    function getUserVideoPokerRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoVideoPoker.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _vpRecordsByIds(videoPoker.getUserBetIds(user, offset, limit));
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentVideoPokerRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ICasinoVideoPoker.FullRecord[] memory) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        return _vpRecordsByIds(videoPoker.getRecentBetIds(offset, limit));
    }

    function _vpRecordsByIds(uint256[] memory ids) internal view returns (ICasinoVideoPoker.FullRecord[] memory out) {
        out = new ICasinoVideoPoker.FullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[i] = videoPoker.getFullRecord(ids[i]);
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
    /// UltimateHoldem, VideoPoker]
    function getRecentBetsAllGamesV2(
        uint256 offsetPerGame,
        uint256 limit
    ) external view override returns (BetRecord[][] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        out = new BetRecord[][](6);
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
    }

    /// @inheritdoc ICasinoDataV2
    /// @dev Returns the game's `nextBetId` — total resolved+pending+cancelled bets is `nextBetId - 1`.
    /// Each game stores `nextBetId` starting at 1, so `nextBetId == 1` means no bets placed yet
    function getNextBetId(GameV2 game) external view override returns (uint256) {
        if (game == GameV2.ThreeCardPoker) return threeCardPoker.nextBetId();
        if (game == GameV2.Plinko) return plinko.nextBetId();
        if (game == GameV2.HiLo) return hilo.nextBetId();
        if (game == GameV2.Keno && address(keno) != address(0)) return keno.nextBetId();
        if (game == GameV2.OvertimeUltimateHoldem && address(ultimateHoldem) != address(0)) {
            return ultimateHoldem.nextBetId();
        }
        if (game == GameV2.VideoPoker && address(videoPoker) != address(0)) {
            return videoPoker.nextBetId();
        }
        return 1; // game not wired yet
    }

    /* ========== INTERNAL: CROSS-GAME GATHER ========== */

    /// @dev Pulls up to `take` bet ids from each game for `user` and packs into a single
    /// BetRecord array. Split into primary/secondary halves to keep within Solidity's stack budget
    function _gatherUserBets(address user, uint256 take) internal view returns (BetRecord[] memory all) {
        BetRecord[] memory pre = _gatherPrimaryUserBets(user, take);
        BetRecord[] memory post = _gatherSecondaryUserBets(user, take);
        all = new BetRecord[](pre.length + post.length);
        uint256 k;
        for (uint256 i; i < pre.length; ++i) all[k++] = pre[i];
        for (uint256 i; i < post.length; ++i) all[k++] = post[i];
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
        return _readVpBase(betId);
    }

    /* ========== INTERNAL: PER-GAME BetRecord PROJECTION ========== */
    /// @dev Each projects a single `getFullRecord` into the slim `BetRecord` shape for cross-game
    /// aggregation. Sharing the FullRecord decoder with the per-game public readers is what keeps
    /// CasinoDataV2 under EIP-170 — switching to `getBetBase` here would add 6 unique tuple
    /// decoders without reusing the existing FullRecord decoder, busting the size budget

    function _readTcpBase(uint256 betId) internal view returns (BetRecord memory b) {
        ICasinoThreeCardPoker.FullRecord memory r = threeCardPoker.getFullRecord(betId);
        b.game = GameV2.ThreeCardPoker;
        b.betId = betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.anteAmount + r.pairPlusAmount;
        b.payout = r.totalPayout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == ICasinoThreeCardPoker.BetStatus.RESOLVED;
        b.cancelled = r.status == ICasinoThreeCardPoker.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _readPlinkoBase(uint256 betId) internal view returns (BetRecord memory b) {
        ICasinoPlinko.FullRecord memory r = plinko.getFullRecord(betId);
        b.game = GameV2.Plinko;
        b.betId = betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.amount;
        b.payout = r.payout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == ICasinoPlinko.BetStatus.RESOLVED;
        b.cancelled = r.status == ICasinoPlinko.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _readHiLoBase(uint256 betId) internal view returns (BetRecord memory b) {
        ICasinoHiLo.FullRecord memory r = hilo.getFullRecord(betId);
        b.game = GameV2.HiLo;
        b.betId = betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.amount;
        b.payout = r.payout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == ICasinoHiLo.BetStatus.RESOLVED;
        b.cancelled = r.status == ICasinoHiLo.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _readKenoBase(uint256 betId) internal view returns (BetRecord memory b) {
        ICasinoKeno.FullRecord memory r = keno.getFullRecord(betId);
        b.game = GameV2.Keno;
        b.betId = betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.amount;
        b.payout = r.payout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == ICasinoKeno.BetStatus.RESOLVED;
        b.cancelled = r.status == ICasinoKeno.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _readUthBase(uint256 betId) internal view returns (BetRecord memory b) {
        ICasinoOvertimeUltimateHoldem.FullRecord memory r = ultimateHoldem.getFullRecord(betId);
        b.game = GameV2.OvertimeUltimateHoldem;
        b.betId = betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.anteAmount * 2 + r.playAmount;
        b.payout = r.totalPayout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == ICasinoOvertimeUltimateHoldem.BetStatus.RESOLVED;
        b.cancelled = r.status == ICasinoOvertimeUltimateHoldem.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _readVpBase(uint256 betId) internal view returns (BetRecord memory b) {
        ICasinoVideoPoker.FullRecord memory r = videoPoker.getFullRecord(betId);
        b.game = GameV2.VideoPoker;
        b.betId = betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.amount;
        b.payout = r.payout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == ICasinoVideoPoker.BetStatus.RESOLVED;
        b.cancelled = r.status == ICasinoVideoPoker.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }
}
