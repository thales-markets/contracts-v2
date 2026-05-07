// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoPlinko
/// @author Overtime
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

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount,
        uint8 rows,
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

    event PaytableUpdated(uint8 indexed rows, Risk indexed risk, uint256[] multipliersE18);

    function placeBet(
        address collateral,
        uint256 amount,
        uint8 rows,
        Risk risk,
        address referrer
    ) external returns (uint256 betId, uint256 requestId);

    function cancelBet(uint256 betId) external;

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
            uint8 rows,
            Risk risk,
            uint8 slotIndex,
            uint256 multiplierE18
        );

    function getPaytable(uint8 rows, Risk risk) external view returns (uint256[] memory multipliersE18);

    function getMaxMultiplierE18(uint8 rows, Risk risk) external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);
}
