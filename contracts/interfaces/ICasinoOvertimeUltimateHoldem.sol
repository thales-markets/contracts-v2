// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoOvertimeUltimateHoldem
/// @author Overtime
/// @notice Ultimate Texas Hold'em vs the dealer with three decision points. Pre-flop the player
/// can raise up to 3× the Ante or check; after the flop they can raise 2× or check; after the
/// river they can raise 1× or fold. Blind pays a bonus paytable on premium hands (Royal Flush
/// down to Straight) when the player wins.
interface ICasinoOvertimeUltimateHoldem {
    /* ========== ENUMS ========== */

    enum BetStatus {
        NONE,
        AWAITING_DEAL, // VRF1 in flight — player hole cards
        PRE_FLOP_TURN, // hole revealed, awaiting raise3x or check
        AWAITING_FLOP, // VRF2 in flight — flop only (player checked pre-flop)
        POST_FLOP_TURN, // flop revealed, awaiting raise2x or check
        AWAITING_TURN_RIVER, // VRF3 in flight — turn + river (player checked post-flop too)
        POST_RIVER_TURN, // all community revealed, awaiting raise1x or fold
        AWAITING_RESOLVE, // final VRF in flight — dealer reveal (+ remaining community if any)
        RESOLVED,
        CANCELLED
    }

    enum Outcome {
        NONE,
        FOLDED,
        DEALER_NOT_QUALIFIED, // Ante pushes, Play and Blind pay normally
        PLAYER_WIN,
        DEALER_WIN,
        TIE
    }

    /* ========== STRUCTS ========== */

    /// @notice Full Ultimate Hold'em record
    struct FullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 playAmount;
        uint256 totalPayout;
        uint256 antePayout;
        uint256 blindPayout;
        uint256 playPayout;
        uint256 placedAt;
        uint256 resolvedAt;
        BetStatus status;
        Outcome outcome;
        uint8[2] playerHole;
        uint8[5] community; // [flop0, flop1, flop2, turn, river]
        uint8[2] dealerHole;
        bool isFreeBet;
        uint256 lastRequestAt;
    }

    /* ========== EVENTS ========== */

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 anteAmount
    );

    event PlayerHoleDealt(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 hole0, uint8 hole1);

    event RaisedPreFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 playAmount);
    event CheckedPreFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user);

    event FlopDealt(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 flop0,
        uint8 flop1,
        uint8 flop2
    );

    event RaisedPostFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 playAmount);
    event CheckedPostFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user);

    event TurnRiverDealt(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 turn, uint8 river);

    event RaisedRiver(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 playAmount);
    event Folded(uint256 indexed betId, address indexed user);

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        Outcome outcome,
        uint8 dealerHole0,
        uint8 dealerHole1,
        uint256 antePayout,
        uint256 blindPayout,
        uint256 playPayout,
        uint256 totalPayout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    /// @notice Emitted when the cap-spill cascade can't absorb the full `cut` from the leg
    /// payouts and the final leg is zero-clamped, losing `residual` from the cut. Structurally
    /// unreachable today (`cut ≤ totalPayout` always); firing indicates a future regression in
    /// the `profitCapRemaining` accounting that off-chain monitoring should alert on
    event CapSpillResidual(uint256 indexed betId, uint256 residual);

    /* ========== EXTERNAL ========== */

    /// @notice Places a UTH bet. Pulls Ante + Blind (= 2 × anteAmount) upfront from the user's
    /// wallet (or FBH if `isFreeBet=true`). Subsequent raises pull from the same source.
    function placeBet(
        address collateral,
        uint256 anteAmount,
        address referrer,
        bool isFreeBet
    ) external returns (uint256 betId, uint256 requestId);

    /// @notice Single-selector mid-game dispatcher. Action codes:
    ///   0 = playPreFlop    1 = checkPreFlop
    ///   2 = playPostFlop   3 = checkPostFlop
    ///   4 = playRiver      5 = fold
    function makeAction(uint256 betId, uint8 action) external returns (uint256 requestId);

    function adminCancelBet(uint256 betId) external;

    /* ========== VIEWS ========== */

    function getBetBase(
        uint256 betId
    )
        external
        view
        returns (
            address user,
            address collateral,
            uint256 anteAmount,
            uint256 playAmount,
            uint256 totalPayout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            Outcome outcome
        );

    function getBetCards(
        uint256 betId
    ) external view returns (uint8[2] memory playerHole, uint8[5] memory community, uint8[2] memory dealerHole);

    function getBetPayouts(
        uint256 betId
    ) external view returns (uint256 antePayout, uint256 blindPayout, uint256 playPayout, uint256 totalPayout);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    /// @notice One-shot full record reader. Single staticcall, all FE-renderable fields
    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    function nextBetId() external view returns (uint256);
}
