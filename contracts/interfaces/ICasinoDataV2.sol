// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoDataV2
/// @author Overtime
/// @notice Read-only aggregator interface for the V2 casino games + treasury. Grows
/// phase-by-phase as new games ship (TCP first, then Hold'em, Plinko, Crash, Mines, Hi-Lo)
interface ICasinoDataV2 {
    /// @notice Canonical game identifier shared with the frontend
    enum GameV2 {
        ThreeCardPoker,
        OvertimeHoldem, // not wired in Phase 1
        Plinko,
        Crash,
        Mines,
        HiLo
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

    /// @notice Uniform per-bet shape for cross-game pagination. Will be populated by every
    /// V2 game once they all ship; Phase 1 fills it from TCP only
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

    /// @notice Full TCP record — all on-chain fields needed to render a single TCP row in the FE
    struct ThreeCardPokerFullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 pairPlusAmount;
        uint256 totalPayout;
        uint256 pairPlusPayout;
        uint256 anteBonusPayout;
        uint256 anteAndPlayPayout;
        uint256 placedAt;
        uint256 resolvedAt;
        uint8 status; // ThreeCardPoker.BetStatus
        uint8 outcome; // ThreeCardPoker.Outcome
        uint8[3] playerCards;
        uint8[3] dealerCards;
    }

    /// @notice Full Hi-Lo record
    struct HiLoFullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        uint8 status; // HiLo.BetStatus
        uint8 outcome; // HiLo.Outcome
        uint8 currentCard;
        uint256 currentMultiplierE18;
        uint8 guessCount;
        uint8 correctCount;
        uint8 pushCount;
    }

    /// @notice Full Mines record
    struct MinesFullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        uint8 status; // Mines.BetStatus
        uint8 outcome; // Mines.Outcome
        uint8 mineCount;
        uint8 safeCount;
        uint32 revealedMask;
        uint32 mineMask; // populated only when status == RESOLVED
    }

    /// @notice Full Crash record
    struct CrashFullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        uint8 status; // Crash.BetStatus
        uint256 targetMultiplierE18;
        uint256 crashPointE18;
        bool won;
    }

    /// @notice Full Plinko record
    struct PlinkoFullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        uint8 status; // Plinko.BetStatus
        uint8 rows;
        uint8 risk; // Plinko.Risk
        uint8 slotIndex;
        uint256 multiplierE18;
    }

    /// @notice Full Hold'em record — all on-chain fields needed to render a single Hold'em row
    struct OvertimeHoldemFullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 aaBonusAmount;
        uint256 totalPayout;
        uint256 aaBonusPayout;
        uint256 antePayout;
        uint256 callPayout;
        uint256 placedAt;
        uint256 resolvedAt;
        uint8 status; // OvertimeHoldem.BetStatus
        uint8 outcome; // OvertimeHoldem.Outcome
        uint8[2] playerHole;
        uint8[5] community; // [flop0, flop1, flop2, turn, river]
        uint8[2] dealerHole;
    }

    /* ========== TREASURY VIEWS ========== */

    function getTreasuryOverview(address[] calldata collaterals) external view returns (TreasuryOverview memory);

    function getGameStatus(address game, address[] calldata collaterals) external view returns (GameStatus memory);

    /* ========== TCP VIEWS ========== */

    function getThreeCardPokerFullRecord(uint256 betId) external view returns (ThreeCardPokerFullRecord memory);

    function getThreeCardPokerFullRecords(
        uint256[] calldata betIds
    ) external view returns (ThreeCardPokerFullRecord[] memory);

    function getUserThreeCardPokerRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ThreeCardPokerFullRecord[] memory);

    function getRecentThreeCardPokerRecords(
        uint256 offset,
        uint256 limit
    ) external view returns (ThreeCardPokerFullRecord[] memory);

    /* ========== HOLD'EM VIEWS ========== */

    function getOvertimeHoldemFullRecord(uint256 betId) external view returns (OvertimeHoldemFullRecord memory);

    function getOvertimeHoldemFullRecords(
        uint256[] calldata betIds
    ) external view returns (OvertimeHoldemFullRecord[] memory);

    function getUserOvertimeHoldemRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (OvertimeHoldemFullRecord[] memory);

    function getRecentOvertimeHoldemRecords(
        uint256 offset,
        uint256 limit
    ) external view returns (OvertimeHoldemFullRecord[] memory);

    /* ========== PLINKO VIEWS ========== */

    function getPlinkoFullRecord(uint256 betId) external view returns (PlinkoFullRecord memory);

    function getPlinkoFullRecords(uint256[] calldata betIds) external view returns (PlinkoFullRecord[] memory);

    function getUserPlinkoRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (PlinkoFullRecord[] memory);

    function getRecentPlinkoRecords(uint256 offset, uint256 limit) external view returns (PlinkoFullRecord[] memory);

    /* ========== CRASH VIEWS ========== */

    function getCrashFullRecord(uint256 betId) external view returns (CrashFullRecord memory);

    function getCrashFullRecords(uint256[] calldata betIds) external view returns (CrashFullRecord[] memory);

    function getUserCrashRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (CrashFullRecord[] memory);

    function getRecentCrashRecords(uint256 offset, uint256 limit) external view returns (CrashFullRecord[] memory);

    /* ========== MINES VIEWS ========== */

    function getMinesFullRecord(uint256 betId) external view returns (MinesFullRecord memory);

    function getMinesFullRecords(uint256[] calldata betIds) external view returns (MinesFullRecord[] memory);

    function getUserMinesRecords(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (MinesFullRecord[] memory);

    function getRecentMinesRecords(uint256 offset, uint256 limit) external view returns (MinesFullRecord[] memory);

    /* ========== HI-LO VIEWS ========== */

    function getHiLoFullRecord(uint256 betId) external view returns (HiLoFullRecord memory);

    function getHiLoFullRecords(uint256[] calldata betIds) external view returns (HiLoFullRecord[] memory);

    function getUserHiLoRecords(address user, uint256 offset, uint256 limit) external view returns (HiLoFullRecord[] memory);

    function getRecentHiLoRecords(uint256 offset, uint256 limit) external view returns (HiLoFullRecord[] memory);

    /* ========== CROSS-GAME (grows per phase) ========== */

    function getUserRecentBetsV2(address user, uint256 offset, uint256 limit) external view returns (BetRecord[] memory);
}
