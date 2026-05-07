// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoCrash
/// @author Overtime
interface ICasinoCrash {
    enum BetStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount,
        uint256 targetMultiplierE18
    );

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint256 crashPointE18,
        bool won,
        uint256 payout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    event HouseEdgeChanged(uint256 newHouseEdgeE18);
    event MaxTargetChanged(uint256 newMaxTargetE18);

    function placeBet(
        address collateral,
        uint256 amount,
        uint256 targetMultiplierE18,
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
            uint256 targetMultiplierE18,
            uint256 crashPointE18,
            bool won
        );

    function houseEdgeE18() external view returns (uint256);

    function maxTargetE18() external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);
}
