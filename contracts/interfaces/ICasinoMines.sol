// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoMines
/// @author Overtime
interface ICasinoMines {
    enum BetStatus {
        NONE,
        AWAITING_DEAL, // VRF1 in flight, mines not yet committed
        ACTIVE, // mines committed, player revealing tiles
        RESOLVED, // player cashed out OR hit a mine
        CANCELLED
    }

    enum Outcome {
        NONE,
        CASHED_OUT,
        HIT_MINE
    }

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount,
        uint8 mineCount
    );

    event MinesCommitted(uint256 indexed betId, address indexed user, uint8 mineCount);

    event TileRevealed(
        uint256 indexed betId,
        address indexed user,
        uint8 tileIndex,
        bool wasMine,
        uint8 safeCount,
        uint256 currentMultiplierE18
    );

    event CashedOut(uint256 indexed betId, address indexed user, uint8 safeCount, uint256 multiplierE18, uint256 payout);

    event BetResolved(uint256 indexed betId, address indexed user, Outcome outcome, uint256 payout);

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    event MaxMultiplierChanged(uint256 newMaxMultiplierE18);
    event HouseEdgeChanged(uint256 newHouseEdgeE18);

    function placeBet(
        address collateral,
        uint256 amount,
        uint8 mineCount,
        address referrer
    ) external returns (uint256 betId, uint256 requestId);

    function revealTile(uint256 betId, uint8 tileIndex) external;

    function cashout(uint256 betId) external;

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
            Outcome outcome,
            uint8 mineCount,
            uint8 safeCount,
            uint32 revealedMask
        );

    function getMineMask(uint256 betId) external view returns (uint32);

    function multiplierE18(uint8 mineCount, uint8 safeCount) external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);
}
