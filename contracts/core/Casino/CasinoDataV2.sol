// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";

import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoThreeCardPoker.sol";
import "../../interfaces/ICasinoOvertimeHoldem.sol";
import "../../interfaces/ICasinoPlinko.sol";
import "../../interfaces/ICasinoHiLo.sol";
import "../../interfaces/ICasinoKeno.sol";
import "../../interfaces/ICasinoDataV2.sol";

/// @title CasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator over `CasinoCoreV2` and the V2 casino games (ThreeCardPoker,
/// OvertimeHoldem, Plinko, HiLo, Keno). No state writes, no funds. Exposes per-game full-record
/// getters and treasury / per-game status views
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
    ICasinoOvertimeHoldem public overtimeHoldem;
    ICasinoPlinko public plinko;
    ICasinoHiLo public hilo;
    ICasinoKeno public keno;

    uint256[34] private __gap;

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

    function setOvertimeHoldem(address _overtimeHoldem) external onlyOwner {
        if (_overtimeHoldem == address(0)) revert InvalidAddress();
        overtimeHoldem = ICasinoOvertimeHoldem(_overtimeHoldem);
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
    function getThreeCardPokerFullRecord(uint256 betId) external view override returns (ThreeCardPokerFullRecord memory) {
        return _readTcp(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getThreeCardPokerFullRecords(
        uint256[] calldata betIds
    ) external view override returns (ThreeCardPokerFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new ThreeCardPokerFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readTcp(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserThreeCardPokerRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (ThreeCardPokerFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = threeCardPoker.getUserBetIds(user, offset, limit);
        out = new ThreeCardPokerFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readTcp(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentThreeCardPokerRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (ThreeCardPokerFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = threeCardPoker.getRecentBetIds(offset, limit);
        out = new ThreeCardPokerFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readTcp(ids[i]);
        }
    }

    /* ========== HOLD'EM VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getOvertimeHoldemFullRecord(uint256 betId) external view override returns (OvertimeHoldemFullRecord memory) {
        return _readHoldem(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getOvertimeHoldemFullRecords(
        uint256[] calldata betIds
    ) external view override returns (OvertimeHoldemFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new OvertimeHoldemFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readHoldem(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserOvertimeHoldemRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (OvertimeHoldemFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = overtimeHoldem.getUserBetIds(user, offset, limit);
        out = new OvertimeHoldemFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readHoldem(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentOvertimeHoldemRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (OvertimeHoldemFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = overtimeHoldem.getRecentBetIds(offset, limit);
        out = new OvertimeHoldemFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readHoldem(ids[i]);
        }
    }

    /* ========== PLINKO VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getPlinkoFullRecord(uint256 betId) external view override returns (PlinkoFullRecord memory) {
        return _readPlinko(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getPlinkoFullRecords(uint256[] calldata betIds) external view override returns (PlinkoFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new PlinkoFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readPlinko(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserPlinkoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (PlinkoFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = plinko.getUserBetIds(user, offset, limit);
        out = new PlinkoFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readPlinko(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentPlinkoRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (PlinkoFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = plinko.getRecentBetIds(offset, limit);
        out = new PlinkoFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readPlinko(ids[i]);
        }
    }

    /* ========== HI-LO VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getHiLoFullRecord(uint256 betId) external view override returns (HiLoFullRecord memory) {
        return _readHiLo(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getHiLoFullRecords(uint256[] calldata betIds) external view override returns (HiLoFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new HiLoFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readHiLo(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserHiLoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (HiLoFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = hilo.getUserBetIds(user, offset, limit);
        out = new HiLoFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readHiLo(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentHiLoRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (HiLoFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = hilo.getRecentBetIds(offset, limit);
        out = new HiLoFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readHiLo(ids[i]);
        }
    }

    /* ========== KENO VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getKenoFullRecord(uint256 betId) external view override returns (KenoFullRecord memory) {
        return _readKeno(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getKenoFullRecords(uint256[] calldata betIds) external view override returns (KenoFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new KenoFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readKeno(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserKenoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (KenoFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = keno.getUserBetIds(user, offset, limit);
        out = new KenoFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readKeno(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentKenoRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (KenoFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = keno.getRecentBetIds(offset, limit);
        out = new KenoFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readKeno(ids[i]);
        }
    }

    /* ========== CROSS-GAME PAGINATION (Phase 1: TCP only) ========== */

    /// @inheritdoc ICasinoDataV2
    /// @dev Merges the most-recent bets from all five games (TCP, Hold'em, Plinko, HiLo, Keno) for
    /// `user`, sorts by `placedAt` desc, and returns the [offset, offset+limit) slice. Pulls
    /// `offset+limit` from each game and merge-sorts in memory — bounded by `5 * MAX_PAGE_LIMIT`
    function getUserRecentBetsV2(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (BetRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        BetRecord[] memory all = _gatherUserBets(user, offset + limit);
        uint256 total = all.length;

        // Insertion sort by placedAt desc — N is small in practice (bounded by 5*MAX_PAGE_LIMIT)
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

    /// @dev Pulls up to `take` bet ids from each game for `user` and packs into a single
    /// BetRecord array. Extracted from getUserRecentBetsV2 to avoid stack-too-deep
    function _gatherUserBets(address user, uint256 take) internal view returns (BetRecord[] memory all) {
        uint256[] memory tcpIds = threeCardPoker.getUserBetIds(user, 0, take);
        uint256[] memory holdemIds = overtimeHoldem.getUserBetIds(user, 0, take);
        uint256[] memory plinkoIds = plinko.getUserBetIds(user, 0, take);
        uint256[] memory hiloIds = hilo.getUserBetIds(user, 0, take);
        uint256[] memory kenoIds = address(keno) != address(0) ? keno.getUserBetIds(user, 0, take) : new uint256[](0);

        uint256 total = tcpIds.length + holdemIds.length + plinkoIds.length + hiloIds.length + kenoIds.length;
        all = new BetRecord[](total);
        uint256 k;
        for (uint256 i; i < tcpIds.length; ++i) all[k++] = _tcpBaseRecord(tcpIds[i]);
        for (uint256 i; i < holdemIds.length; ++i) all[k++] = _holdemBaseRecord(holdemIds[i]);
        for (uint256 i; i < plinkoIds.length; ++i) all[k++] = _plinkoBaseRecord(plinkoIds[i]);
        for (uint256 i; i < hiloIds.length; ++i) all[k++] = _hiloBaseRecord(hiloIds[i]);
        for (uint256 i; i < kenoIds.length; ++i) all[k++] = _kenoBaseRecord(kenoIds[i]);
    }

    /// @inheritdoc ICasinoDataV2
    /// @dev One inner array per game in `GameV2` enum order: [TCP, Hold'em, Plinko, HiLo, Keno].
    /// Each inner array is the latest `limit` bets for that game starting at `offsetPerGame`
    function getRecentBetsAllGamesV2(
        uint256 offsetPerGame,
        uint256 limit
    ) external view override returns (BetRecord[][] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        out = new BetRecord[][](5);

        uint256[] memory ids = threeCardPoker.getRecentBetIds(offsetPerGame, limit);
        out[uint256(GameV2.ThreeCardPoker)] = new BetRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[uint256(GameV2.ThreeCardPoker)][i] = _tcpBaseRecord(ids[i]);

        ids = overtimeHoldem.getRecentBetIds(offsetPerGame, limit);
        out[uint256(GameV2.OvertimeHoldem)] = new BetRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[uint256(GameV2.OvertimeHoldem)][i] = _holdemBaseRecord(ids[i]);

        ids = plinko.getRecentBetIds(offsetPerGame, limit);
        out[uint256(GameV2.Plinko)] = new BetRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[uint256(GameV2.Plinko)][i] = _plinkoBaseRecord(ids[i]);

        ids = hilo.getRecentBetIds(offsetPerGame, limit);
        out[uint256(GameV2.HiLo)] = new BetRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) out[uint256(GameV2.HiLo)][i] = _hiloBaseRecord(ids[i]);

        if (address(keno) != address(0)) {
            ids = keno.getRecentBetIds(offsetPerGame, limit);
            out[uint256(GameV2.Keno)] = new BetRecord[](ids.length);
            for (uint256 i; i < ids.length; ++i) out[uint256(GameV2.Keno)][i] = _kenoBaseRecord(ids[i]);
        } else {
            out[uint256(GameV2.Keno)] = new BetRecord[](0);
        }
    }

    /// @inheritdoc ICasinoDataV2
    /// @dev Returns the game's `nextBetId` — total resolved+pending+cancelled bets is `nextBetId - 1`.
    /// Each game stores `nextBetId` starting at 1, so `nextBetId == 1` means no bets placed yet
    function getNextBetId(GameV2 game) external view override returns (uint256) {
        if (game == GameV2.ThreeCardPoker) return _nextBetIdFromIds(threeCardPoker.getRecentBetIds(0, 1));
        if (game == GameV2.OvertimeHoldem) return _nextBetIdFromIds(overtimeHoldem.getRecentBetIds(0, 1));
        if (game == GameV2.Plinko) return _nextBetIdFromIds(plinko.getRecentBetIds(0, 1));
        if (game == GameV2.HiLo) return _nextBetIdFromIds(hilo.getRecentBetIds(0, 1));
        if (game == GameV2.Keno && address(keno) != address(0)) return _nextBetIdFromIds(keno.getRecentBetIds(0, 1));
        return 1; // game not wired yet
    }

    /// @dev Each game's `getRecentBetIds(0, 1)` returns the most-recent bet id, so nextBetId = id + 1
    function _nextBetIdFromIds(uint256[] memory ids) internal pure returns (uint256) {
        if (ids.length == 0) return 1;
        return ids[0] + 1;
    }

    function _tcpBaseRecord(uint256 betId) internal view returns (BetRecord memory b) {
        (
            address user,
            address collateral,
            uint256 ante,
            uint256 pp,
            uint256 totalPayout,
            uint256 placedAt,
            ,
            ICasinoThreeCardPoker.BetStatus status,

        ) = threeCardPoker.getBetBase(betId);
        b.game = GameV2.ThreeCardPoker;
        b.betId = betId;
        b.user = user;
        b.collateral = collateral;
        b.amount = ante + pp;
        b.payout = totalPayout;
        b.placedAt = placedAt;
        b.resolved = status == ICasinoThreeCardPoker.BetStatus.RESOLVED;
        b.cancelled = status == ICasinoThreeCardPoker.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _holdemBaseRecord(uint256 betId) internal view returns (BetRecord memory b) {
        (
            address user,
            address collateral,
            uint256 ante,
            uint256 aaBonus,
            uint256 totalPayout,
            uint256 placedAt,
            ,
            ICasinoOvertimeHoldem.BetStatus status,

        ) = overtimeHoldem.getBetBase(betId);
        b.game = GameV2.OvertimeHoldem;
        b.betId = betId;
        b.user = user;
        b.collateral = collateral;
        b.amount = ante + aaBonus;
        b.payout = totalPayout;
        b.placedAt = placedAt;
        b.resolved = status == ICasinoOvertimeHoldem.BetStatus.RESOLVED;
        b.cancelled = status == ICasinoOvertimeHoldem.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _plinkoBaseRecord(uint256 betId) internal view returns (BetRecord memory b) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            ,
            ICasinoPlinko.BetStatus status,
            ,
            ,

        ) = plinko.getBetBase(betId);
        b.game = GameV2.Plinko;
        b.betId = betId;
        b.user = user;
        b.collateral = collateral;
        b.amount = amount;
        b.payout = payout;
        b.placedAt = placedAt;
        b.resolved = status == ICasinoPlinko.BetStatus.RESOLVED;
        b.cancelled = status == ICasinoPlinko.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _hiloBaseRecord(uint256 betId) internal view returns (BetRecord memory b) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            ,
            ICasinoHiLo.BetStatus status,

        ) = hilo.getBetBase(betId);
        b.game = GameV2.HiLo;
        b.betId = betId;
        b.user = user;
        b.collateral = collateral;
        b.amount = amount;
        b.payout = payout;
        b.placedAt = placedAt;
        b.resolved = status == ICasinoHiLo.BetStatus.RESOLVED;
        b.cancelled = status == ICasinoHiLo.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    function _kenoBaseRecord(uint256 betId) internal view returns (BetRecord memory b) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            ,
            ICasinoKeno.BetStatus status,
            ,
            ,
            ,
            ,

        ) = keno.getBetBase(betId);
        b.game = GameV2.Keno;
        b.betId = betId;
        b.user = user;
        b.collateral = collateral;
        b.amount = amount;
        b.payout = payout;
        b.placedAt = placedAt;
        b.resolved = status == ICasinoKeno.BetStatus.RESOLVED;
        b.cancelled = status == ICasinoKeno.BetStatus.CANCELLED;
        b.won = b.resolved && b.payout > b.amount;
    }

    /* ========== INTERNAL ========== */

    function _readTcp(uint256 betId) internal view returns (ThreeCardPokerFullRecord memory r) {
        r.betId = betId;
        _readTcpBase(betId, r);
        _readTcpCards(betId, r);
        _readTcpPayouts(betId, r);
    }

    function _readTcpBase(uint256 betId, ThreeCardPokerFullRecord memory r) internal view {
        (
            address user,
            address collateral,
            uint256 anteAmount,
            uint256 pairPlusAmount,
            uint256 totalPayout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoThreeCardPoker.BetStatus status,
            ICasinoThreeCardPoker.Outcome outcome
        ) = threeCardPoker.getBetBase(betId);
        r.user = user;
        r.collateral = collateral;
        r.anteAmount = anteAmount;
        r.pairPlusAmount = pairPlusAmount;
        r.totalPayout = totalPayout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.outcome = uint8(outcome);
    }

    function _readTcpCards(uint256 betId, ThreeCardPokerFullRecord memory r) internal view {
        (uint8[3] memory pCards, uint8[3] memory dCards) = threeCardPoker.getBetCards(betId);
        r.playerCards = pCards;
        r.dealerCards = dCards;
    }

    function _readTcpPayouts(uint256 betId, ThreeCardPokerFullRecord memory r) internal view {
        (uint256 pp, uint256 ab, uint256 ap, ) = threeCardPoker.getBetPayouts(betId);
        r.pairPlusPayout = pp;
        r.anteBonusPayout = ab;
        r.anteAndPlayPayout = ap;
    }

    function _toBetRecord(ThreeCardPokerFullRecord memory r) internal pure returns (BetRecord memory b) {
        b.game = GameV2.ThreeCardPoker;
        b.betId = r.betId;
        b.user = r.user;
        b.collateral = r.collateral;
        b.amount = r.anteAmount + r.pairPlusAmount;
        b.payout = r.totalPayout;
        b.placedAt = r.placedAt;
        b.resolved = r.status == uint8(ICasinoThreeCardPoker.BetStatus.RESOLVED);
        b.cancelled = r.status == uint8(ICasinoThreeCardPoker.BetStatus.CANCELLED);
        // Won iff resolved AND payout > total stake (note: Pair Plus alone without Play decision
        // can pay > pp stake; treat any net-positive payout as a win)
        b.won = b.resolved && b.payout > b.amount;
    }

    function _readHoldem(uint256 betId) internal view returns (OvertimeHoldemFullRecord memory r) {
        r.betId = betId;
        _readHoldemBase(betId, r);
        _readHoldemCards(betId, r);
        _readHoldemPayouts(betId, r);
    }

    function _readHoldemBase(uint256 betId, OvertimeHoldemFullRecord memory r) internal view {
        (
            address user,
            address collateral,
            uint256 anteAmount,
            uint256 aaBonusAmount,
            uint256 totalPayout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoOvertimeHoldem.BetStatus status,
            ICasinoOvertimeHoldem.Outcome outcome
        ) = overtimeHoldem.getBetBase(betId);
        r.user = user;
        r.collateral = collateral;
        r.anteAmount = anteAmount;
        r.aaBonusAmount = aaBonusAmount;
        r.totalPayout = totalPayout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.outcome = uint8(outcome);
    }

    function _readHoldemCards(uint256 betId, OvertimeHoldemFullRecord memory r) internal view {
        (uint8[2] memory ph, uint8[5] memory cm, uint8[2] memory dh) = overtimeHoldem.getBetCards(betId);
        r.playerHole = ph;
        r.community = cm;
        r.dealerHole = dh;
    }

    function _readHoldemPayouts(uint256 betId, OvertimeHoldemFullRecord memory r) internal view {
        (uint256 aa, uint256 ant, uint256 cp, ) = overtimeHoldem.getBetPayouts(betId);
        r.aaBonusPayout = aa;
        r.antePayout = ant;
        r.callPayout = cp;
    }

    function _readHiLo(uint256 betId) internal view returns (HiLoFullRecord memory r) {
        r.betId = betId;
        _readHiLoBase(betId, r);
        _readHiLoState(betId, r);
    }

    function _readHiLoBase(uint256 betId, HiLoFullRecord memory r) internal view {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoHiLo.BetStatus status,
            ICasinoHiLo.Outcome outcome
        ) = hilo.getBetBase(betId);
        r.user = user;
        r.collateral = collateral;
        r.amount = amount;
        r.payout = payout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.outcome = uint8(outcome);
    }

    function _readHiLoState(uint256 betId, HiLoFullRecord memory r) internal view {
        (uint8 lc, uint256 cm, uint8 gc, uint8 corr, uint8 push) = hilo.getBetState(betId);
        r.lastCard = lc;
        r.currentMultiplierE18 = cm;
        r.guessCount = gc;
        r.correctCount = corr;
        r.pushCount = push;
    }

    function _readKeno(uint256 betId) internal view returns (KenoFullRecord memory r) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoKeno.BetStatus status,
            uint8 picksCount,
            uint8 hits,
            uint128 picksMask,
            uint128 drawnMask,
            uint256 multiplierE18
        ) = keno.getBetBase(betId);
        r.betId = betId;
        r.user = user;
        r.collateral = collateral;
        r.amount = amount;
        r.payout = payout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.picksCount = picksCount;
        r.hits = hits;
        r.picksMask = picksMask;
        r.drawnMask = drawnMask;
        r.multiplierE18 = multiplierE18;
    }

    function _readPlinko(uint256 betId) internal view returns (PlinkoFullRecord memory r) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoPlinko.BetStatus status,
            ICasinoPlinko.Risk risk,
            uint8 slotIndex,
            uint256 multiplierE18
        ) = plinko.getBetBase(betId);
        r.betId = betId;
        r.user = user;
        r.collateral = collateral;
        r.amount = amount;
        r.payout = payout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.risk = uint8(risk);
        r.slotIndex = slotIndex;
        r.multiplierE18 = multiplierE18;
    }
}
