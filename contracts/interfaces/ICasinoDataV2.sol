// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ICasinoThreeCardPoker.sol";
import "./ICasinoPlinko.sol";
import "./ICasinoHiLo.sol";
import "./ICasinoKeno.sol";
import "./ICasinoOvertimeUltimateHoldem.sol";
import "./ICasinoVideoPoker.sol";

/// @title ICasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator interface for the V2 casino games + treasury. Covers
/// ThreeCardPoker, OvertimeUltimateHoldem, Plinko, HiLo, Keno, VideoPoker. Per-game `FullRecord`
/// struct definitions live on each game's own interface — this aggregator just forwards
interface ICasinoDataV2 {
    /// @notice Canonical game identifier shared with the frontend
    enum GameV2 {
        ThreeCardPoker,
        Plinko,
        HiLo,
        Keno,
        OvertimeUltimateHoldem,
        VideoPoker
    }

    /// @notice Treasury-wide summary view
    struct TreasuryOverview {
        address core;
        address freeBetsHolder;
        bool paused;
        uint256 maxProfitUsd;
        uint256 cancelTimeout;
        uint256 defaultMaxNetLossPerGameUsd;
        address[] registeredGames;
        // per-collateral arrays, indexed by `collaterals` order
        address[] collaterals;
        uint256[] balancePerCollateral;
        uint256[] reservedPerCollateral;
        uint256[] availablePerCollateral;
    }

    /// @notice Per-game treasury state
    struct GameStatus {
        address game;
        bool registered;
        bool paused;
        bool autoPaused;
        int256 houseNetUsd;
        uint256 maxNetLossUsd;
        // per-collateral reservation, indexed by `collaterals` order
        address[] collaterals;
        uint256[] reservedPerCollateral;
    }

    /// @notice Uniform per-bet shape for cross-game pagination. Populated by every V2 game
    struct BetRecord {
        GameV2 game;
        uint256 betId;
        address user;
        address collateral;
        uint256 amount; // primary stake (Ante for TCP, etc.)
        uint256 payout; // total payout
        uint256 placedAt;
        bool resolved;
        bool cancelled;
        bool won;
    }

    /* ========== TREASURY VIEWS ========== */

    function getTreasuryOverview(address[] calldata collaterals) external view returns (TreasuryOverview memory);

    function getGameStatus(address game, address[] calldata collaterals) external view returns (GameStatus memory);

    /* ========== TCP VIEWS ========== */

    function getThreeCardPokerFullRecord(uint256 betId) external view returns (ICasinoThreeCardPoker.FullRecord memory);

    function getThreeCardPokerFullRecords(
        uint256[] calldata betIds
    ) external view returns (ICasinoThreeCardPoker.FullRecord[] memory);

    function getUserThreeCardPokerRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoThreeCardPoker.FullRecord[] memory);

    function getRecentThreeCardPokerRecords(
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoThreeCardPoker.FullRecord[] memory);

    /* ========== PLINKO VIEWS ========== */

    function getPlinkoFullRecord(uint256 betId) external view returns (ICasinoPlinko.FullRecord memory);

    function getPlinkoFullRecords(uint256[] calldata betIds) external view returns (ICasinoPlinko.FullRecord[] memory);

    function getUserPlinkoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoPlinko.FullRecord[] memory);

    function getRecentPlinkoRecords(uint256 offset, uint256 limit) external view returns (ICasinoPlinko.FullRecord[] memory);

    /* ========== HI-LO VIEWS ========== */

    function getHiLoFullRecord(uint256 betId) external view returns (ICasinoHiLo.FullRecord memory);

    function getHiLoFullRecords(uint256[] calldata betIds) external view returns (ICasinoHiLo.FullRecord[] memory);

    function getUserHiLoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoHiLo.FullRecord[] memory);

    function getRecentHiLoRecords(uint256 offset, uint256 limit) external view returns (ICasinoHiLo.FullRecord[] memory);

    /* ========== KENO VIEWS ========== */

    function getKenoFullRecord(uint256 betId) external view returns (ICasinoKeno.FullRecord memory);

    function getKenoFullRecords(uint256[] calldata betIds) external view returns (ICasinoKeno.FullRecord[] memory);

    function getUserKenoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoKeno.FullRecord[] memory);

    function getRecentKenoRecords(uint256 offset, uint256 limit) external view returns (ICasinoKeno.FullRecord[] memory);

    /* ========== ULTIMATE HOLD'EM VIEWS ========== */

    function getOvertimeUltimateHoldemFullRecord(
        uint256 betId
    ) external view returns (ICasinoOvertimeUltimateHoldem.FullRecord memory);

    function getOvertimeUltimateHoldemFullRecords(
        uint256[] calldata betIds
    ) external view returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory);

    function getUserOvertimeUltimateHoldemRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory);

    function getRecentOvertimeUltimateHoldemRecords(
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoOvertimeUltimateHoldem.FullRecord[] memory);

    /* ========== VIDEO POKER VIEWS ========== */

    function getVideoPokerFullRecord(uint256 betId) external view returns (ICasinoVideoPoker.FullRecord memory);

    function getVideoPokerFullRecords(
        uint256[] calldata betIds
    ) external view returns (ICasinoVideoPoker.FullRecord[] memory);

    function getUserVideoPokerRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoVideoPoker.FullRecord[] memory);

    function getRecentVideoPokerRecords(
        uint256 offset,
        uint256 limit
    ) external view returns (ICasinoVideoPoker.FullRecord[] memory);

    /* ========== CROSS-GAME (monitoring) ========== */

    /// @notice Recent bets per game in lite `BetRecord` shape, returned as one inner array per
    /// game in `GameV2` enum order. `offsetPerGame` and `limit` apply identically to each
    /// game's pagination. Outer array is dynamic so adding a new game just appends
    function getRecentBetsAllGamesV2(uint256 offsetPerGame, uint256 limit) external view returns (BetRecord[][] memory);

    /// @notice User's recent bets across all games, sorted by `placedAt` desc, sliced by
    /// offset/limit. Pulls `offset+limit` from each game and merge-sorts in memory
    function getUserRecentBetsV2(address user, uint256 offset, uint256 limit) external view returns (BetRecord[] memory);

    /// @notice Returns the next bet id (= total placed bets + 1) for `game`. Useful for "Page X
    /// of Y" displays — total resolved bets is `getNextBetId(game) - 1`
    function getNextBetId(GameV2 game) external view returns (uint256);
}
