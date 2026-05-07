// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";

import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoThreeCardPoker.sol";
import "../../interfaces/ICasinoOvertimeHoldem.sol";
import "../../interfaces/ICasinoPlinko.sol";
import "../../interfaces/ICasinoCrash.sol";
import "../../interfaces/ICasinoMines.sol";
import "../../interfaces/ICasinoHiLo.sol";
import "../../interfaces/ICasinoDataV2.sol";

/// @title CasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator over `CasinoCoreV2` and the V2 casino games. No state writes,
/// no funds. Grows phase-by-phase as new games (Hold'em, Plinko, Crash, Mines, Hi-Lo) ship —
/// each phase wires its game and adds its full-record getters. Phase 1 covers ThreeCardPoker
/// plus the treasury views
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
    ICasinoCrash public crash;
    ICasinoMines public mines;
    ICasinoHiLo public hilo;

    uint256[35] private __gap;

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

    function setCrash(address _crash) external onlyOwner {
        if (_crash == address(0)) revert InvalidAddress();
        crash = ICasinoCrash(_crash);
    }

    function setMines(address _mines) external onlyOwner {
        if (_mines == address(0)) revert InvalidAddress();
        mines = ICasinoMines(_mines);
    }

    function setHiLo(address _hilo) external onlyOwner {
        if (_hilo == address(0)) revert InvalidAddress();
        hilo = ICasinoHiLo(_hilo);
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

    /* ========== CRASH VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getCrashFullRecord(uint256 betId) external view override returns (CrashFullRecord memory) {
        return _readCrash(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getCrashFullRecords(uint256[] calldata betIds) external view override returns (CrashFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new CrashFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readCrash(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserCrashRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (CrashFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = crash.getUserBetIds(user, offset, limit);
        out = new CrashFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readCrash(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentCrashRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (CrashFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = crash.getRecentBetIds(offset, limit);
        out = new CrashFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readCrash(ids[i]);
        }
    }

    /* ========== MINES VIEWS ========== */

    /// @inheritdoc ICasinoDataV2
    function getMinesFullRecord(uint256 betId) external view override returns (MinesFullRecord memory) {
        return _readMines(betId);
    }

    /// @inheritdoc ICasinoDataV2
    function getMinesFullRecords(uint256[] calldata betIds) external view override returns (MinesFullRecord[] memory out) {
        if (betIds.length > MAX_BATCH_IDS) revert LimitExceeded();
        out = new MinesFullRecord[](betIds.length);
        for (uint256 i; i < betIds.length; ++i) {
            out[i] = _readMines(betIds[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getUserMinesRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (MinesFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = mines.getUserBetIds(user, offset, limit);
        out = new MinesFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readMines(ids[i]);
        }
    }

    /// @inheritdoc ICasinoDataV2
    function getRecentMinesRecords(
        uint256 offset,
        uint256 limit
    ) external view override returns (MinesFullRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = mines.getRecentBetIds(offset, limit);
        out = new MinesFullRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _readMines(ids[i]);
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

    /* ========== CROSS-GAME PAGINATION (Phase 1: TCP only) ========== */

    /// @inheritdoc ICasinoDataV2
    /// @dev Phase 1 returns TCP records only. Each new phase extends this method to interleave
    /// the new game's records sorted by `placedAt`
    function getUserRecentBetsV2(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (BetRecord[] memory out) {
        if (limit > MAX_PAGE_LIMIT) revert LimitExceeded();
        uint256[] memory ids = threeCardPoker.getUserBetIds(user, offset, limit);
        out = new BetRecord[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            ThreeCardPokerFullRecord memory r = _readTcp(ids[i]);
            out[i] = _toBetRecord(r);
        }
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
        (uint8 cc, uint256 cm, uint8 gc, uint8 corr, uint8 push) = hilo.getBetState(betId);
        r.currentCard = cc;
        r.currentMultiplierE18 = cm;
        r.guessCount = gc;
        r.correctCount = corr;
        r.pushCount = push;
    }

    function _readMines(uint256 betId) internal view returns (MinesFullRecord memory r) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoMines.BetStatus status,
            ICasinoMines.Outcome outcome,
            uint8 mineCount,
            uint8 safeCount,
            uint32 revealedMask
        ) = mines.getBetBase(betId);
        r.betId = betId;
        r.user = user;
        r.collateral = collateral;
        r.amount = amount;
        r.payout = payout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.outcome = uint8(outcome);
        r.mineCount = mineCount;
        r.safeCount = safeCount;
        r.revealedMask = revealedMask;
        // Only expose mine mask once the bet is final
        if (status == ICasinoMines.BetStatus.RESOLVED || status == ICasinoMines.BetStatus.CANCELLED) {
            r.mineMask = mines.getMineMask(betId);
        }
    }

    function _readCrash(uint256 betId) internal view returns (CrashFullRecord memory r) {
        (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            ICasinoCrash.BetStatus status,
            uint256 targetMultiplierE18,
            uint256 crashPointE18,
            bool won
        ) = crash.getBetBase(betId);
        r.betId = betId;
        r.user = user;
        r.collateral = collateral;
        r.amount = amount;
        r.payout = payout;
        r.placedAt = placedAt;
        r.resolvedAt = resolvedAt;
        r.status = uint8(status);
        r.targetMultiplierE18 = targetMultiplierE18;
        r.crashPointE18 = crashPointE18;
        r.won = won;
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
            uint8 rows,
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
        r.rows = rows;
        r.risk = uint8(risk);
        r.slotIndex = slotIndex;
        r.multiplierE18 = multiplierE18;
    }
}
