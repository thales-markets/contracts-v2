// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoKeno
/// @author Overtime
/// @notice Single-shot Keno: 80-number pool, 20 numbers drawn per round, player picks 1–10
/// numbers before the draw. Payout is `bet × paytable[picksCount][hits]` where `hits` is the
/// overlap between the player's picks and the 20 drawn numbers. Multipliers stored in 1e18
/// precision and capped at 100x. Per-bet liability is bounded by both the multiplier cap and
/// a $10 max bet, giving a hard $1000 ceiling per bet
interface ICasinoKeno {
    enum BetStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    /// @notice Full Keno record
    struct FullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        BetStatus status;
        uint8 picksCount;
        uint8 hits;
        uint128 picksMask; // bitmask of player's picks (numbers 1..80 → bits 0..79)
        uint128 drawnMask; // bitmask of the 20 drawn numbers (set when status == RESOLVED)
        uint256 multiplierE18;
        bool isFreeBet;
    }

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount,
        uint8 picksCount,
        uint128 picksMask
    );

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint128 drawnMask,
        uint8 hits,
        uint256 multiplierE18,
        uint256 payout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    event PaytableUpdated(uint8 indexed picksCount, uint256[] multipliersE18);

    /// @notice Places a Keno bet. `picks` must be a sorted, deduplicated array of 1..80,
    /// length 1..10. One VRF word resolves the bet
    function placeBet(
        address collateral,
        uint256 amount,
        uint8[] calldata picks,
        address referrer
    ) external returns (uint256 betId, uint256 requestId);

    /// @notice Places a Keno bet using the user's free-bet balance held in FreeBetsHolder.
    /// Same flow as `placeBet` but stake is pulled from FBH and the bet is flagged so payouts
    /// route back to FBH on resolution. Reverts if FBH balance < amount
    function placeBetWithFreeBet(
        address collateral,
        uint256 amount,
        uint8[] calldata picks,
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
            uint8 picksCount,
            uint8 hits,
            uint128 picksMask,
            uint128 drawnMask,
            uint256 multiplierE18
        );

    function getPaytable(uint8 picksCount) external view returns (uint256[] memory multipliersE18);

    function getMaxMultiplierE18() external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    /// @notice One-shot full record reader
    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    function nextBetId() external view returns (uint256);
}
