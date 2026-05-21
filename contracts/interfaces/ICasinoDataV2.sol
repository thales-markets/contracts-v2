// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ICasinoThreeCardPoker.sol";
import "./ICasinoPlinko.sol";
import "./ICasinoHiLo.sol";
import "./ICasinoKeno.sol";
import "./ICasinoOvertimeUltimateHoldem.sol";
import "./ICasinoVideoPoker.sol";
import "./ICasinoOvertimeBonusHoldem.sol";

/// @title ICasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator interface for the V2 casino games + treasury. Covers
/// ThreeCardPoker, OvertimeUltimateHoldem, Plinko, HiLo, Keno, VideoPoker, OvertimeBonusHoldem.
/// Per-game `FullRecord`
/// struct definitions live on each game's own interface. Reads return `bytes` (ABI-encoded
/// per-game struct/array) so a single dispatcher serves every game — caller does
/// `abi.decode(result, (ICasinoX.FullRecord))` (or `(ICasinoX.FullRecord[])`) per the GameV2 enum
interface ICasinoDataV2 {
    /// @notice Canonical game identifier shared with the frontend
    enum GameV2 {
        ThreeCardPoker,
        Plinko,
        HiLo,
        Keno,
        OvertimeUltimateHoldem,
        VideoPoker,
        OvertimeBonusHoldem
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

    /* ========== PER-GAME RECORDS (typed bytes; caller abi.decodes per GameV2) ========== */

    /// @notice Single record. Decode as `abi.decode(result, (ICasinoX.FullRecord))` per `game`.
    function getFullRecord(GameV2 game, uint256 betId) external view returns (bytes memory);

    /// @notice Batch records by ids. Decode as `abi.decode(result, (ICasinoX.FullRecord[]))`.
    function getFullRecords(GameV2 game, uint256[] calldata betIds) external view returns (bytes memory);

    /// @notice User-paginated records (most-recent first). Decode as `(ICasinoX.FullRecord[])`.
    function getUserRecords(GameV2 game, address user, uint256 offset, uint256 limit) external view returns (bytes memory);

    /// @notice Recent-paginated records (descending by bet id). Decode as `(ICasinoX.FullRecord[])`.
    function getRecentRecords(GameV2 game, uint256 offset, uint256 limit) external view returns (bytes memory);

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
