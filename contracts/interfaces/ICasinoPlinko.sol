// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoPlinko
/// @author Overtime
/// @notice 8-row Plinko with 3 risk levels (LOW/MED/HIGH). Player picks risk; one VRF word
/// resolves the bet. The slot index is `popcount(low 8 bits of word)`, addressing a
/// risk-specific paytable. Multipliers stored in 1e18 precision
interface ICasinoPlinko {
    enum BetStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    enum Risk {
        LOW,
        MED,
        HIGH
    }

    /// @notice Full Plinko record (8-row, single mode)
    struct FullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        BetStatus status;
        Risk risk;
        uint8 slotIndex;
        uint256 multiplierE18;
        bool isFreeBet;
        uint256 lastRequestAt;
    }

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount,
        Risk risk
    );

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 slotIndex,
        uint256 multiplierE18,
        uint256 payout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    event PaytableUpdated(Risk indexed risk, uint256[] multipliersE18);

    /// @notice Places a Plinko bet. `isFreeBet=true` pulls the stake from FreeBetsHolder and
    /// flags the bet so payouts route back to FBH on resolve; `false` pulls from the user's
    /// wallet. Single canonical entry — gasless sessions allowlist this selector
    function placeBet(
        address collateral,
        uint256 amount,
        Risk risk,
        address referrer,
        bool isFreeBet
    ) external returns (uint256 betId, uint256 requestId);

    function adminCancelBet(uint256 betId) external;

    function getBetBase(
        uint256 betId
    )
        external
        view
        returns (
            address user,
            address collateral,
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            Risk risk,
            uint8 slotIndex,
            uint256 multiplierE18
        );

    function getPaytable(Risk risk) external view returns (uint256[] memory multipliersE18);

    function getMaxMultiplierE18(Risk risk) external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    /// @notice One-shot full record reader. Single staticcall, all FE-renderable fields
    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    function nextBetId() external view returns (uint256);
}
