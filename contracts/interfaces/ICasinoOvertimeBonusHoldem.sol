// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoOvertimeBonusHoldem
/// @author Overtime
/// @notice Texas Hold'em Bonus / Casino Hold'em variant against the dealer. Mandatory ANTE +
/// optional BONUS side bet. Pre-flop is "Play 2× or fold"; each later street allows one optional
/// 1× raise or check. No dealer qualification. ANTE pays 1:1 only on Straight+, otherwise pushes
interface ICasinoOvertimeBonusHoldem {
    /* ========== ENUMS ========== */

    enum BetStatus {
        NONE,
        AWAITING_HOLE,
        PRE_FLOP_TURN,
        AWAITING_FLOP,
        FLOP_TURN,
        AWAITING_TURN,
        TURN_TURN,
        AWAITING_RIVER,
        RIVER_TURN,
        AWAITING_RESOLVE,
        RESOLVED,
        CANCELLED
    }

    enum Outcome {
        NONE,
        FOLDED,
        PLAYER_WIN,
        DEALER_WIN,
        TIE
    }

    /* ========== STRUCTS ========== */

    /// @notice Full bet record returned by `getFullRecord`. Per-leg payout breakdown lets FE
    /// render exactly how each stake leg settled
    struct FullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 bonusAmount;
        uint256 playAmount; // 2× ante if pre-flop Play taken, else 0 (folded pre-flop)
        uint256 flopRaise; // 1× ante if raised on flop
        uint256 turnRaise; // 1× ante if raised on turn
        uint256 riverRaise; // 1× ante if raised on river
        uint256 totalPayout;
        uint256 antePayout;
        uint256 bonusPayout;
        uint256 playPayout;
        uint256 flopPayout;
        uint256 turnPayout;
        uint256 riverPayout;
        uint256 placedAt;
        uint256 resolvedAt;
        BetStatus status;
        Outcome outcome;
        uint8[2] playerHole;
        uint8[5] community; // [flop0, flop1, flop2, turn, river]
        uint8[2] dealerHole;
        bool isFreeBet;
    }

    /* ========== EVENTS ========== */

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 anteAmount,
        uint256 bonusAmount
    );

    event PlayerHoleDealt(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 hole0, uint8 hole1);

    event PlayedPreFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 playAmount);

    event FlopDealt(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 flop0,
        uint8 flop1,
        uint8 flop2
    );

    event RaisedFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 raiseAmount);
    event CheckedFlop(uint256 indexed betId, uint256 indexed requestId, address indexed user);

    event TurnDealt(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 turn);
    event RaisedTurn(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 raiseAmount);
    event CheckedTurn(uint256 indexed betId, uint256 indexed requestId, address indexed user);

    event RiverDealt(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 river);
    event RaisedRiver(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 raiseAmount);
    event CheckedRiver(uint256 indexed betId, uint256 indexed requestId, address indexed user);

    event Folded(uint256 indexed betId, address indexed user, BetStatus stage);

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        Outcome outcome,
        uint8 dealer0,
        uint8 dealer1,
        uint256 antePayout,
        uint256 bonusPayout,
        uint256 mainPayout,
        uint256 totalPayout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refund, bool adminCancelled);

    /* ========== STATE-CHANGING ========== */

    /// @notice Places a BH bet. `isFreeBet=true` pulls Ante + Bonus from FBH; `false` from the
    /// user's wallet. Bonus must be zero when `isFreeBet` is true
    /// (reverts `BonusNotAllowedForFreeBet`)
    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 bonusAmount,
        address referrer,
        bool isFreeBet
    ) external returns (uint256 betId, uint256 requestId);

    /// @notice Single-selector mid-game dispatcher. Action codes:
    ///   0 = playPreFlop    1 = foldPreFlop
    ///   2 = raiseFlop      3 = checkFlop
    ///   4 = raiseTurn      5 = checkTurn
    ///   6 = raiseRiver     7 = checkRiver
    /// No fold post-flop: `check*` is free, so any post-flop fold is strictly dominated in money
    /// EV (lose ante guaranteed vs free chance to win at showdown). Use check at every post-flop
    /// street; raise to commit additional stake
    function makeAction(uint256 betId, uint8 action) external returns (uint256 requestId);

    function cancelBet(uint256 betId) external;
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
            uint256 bonusAmount,
            uint256 totalPayout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            Outcome outcome
        );

    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function nextBetId() external view returns (uint256);
}
