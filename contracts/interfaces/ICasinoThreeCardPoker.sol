// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoThreeCardPoker
/// @author Overtime
interface ICasinoThreeCardPoker {
    /* ========== ENUMS ========== */

    enum BetStatus {
        NONE,
        AWAITING_DEAL, // VRF1 in flight, player cards not yet revealed
        PLAYER_TURN, // player cards revealed, awaiting fold/play
        AWAITING_RESOLVE, // Play chosen, VRF2 in flight, dealer not yet dealt
        RESOLVED,
        CANCELLED
    }

    enum HandClass {
        HIGH_CARD,
        PAIR,
        FLUSH,
        STRAIGHT,
        THREE_OF_A_KIND,
        STRAIGHT_FLUSH
    }

    enum Outcome {
        NONE,
        FOLDED,
        DEALER_NOT_QUALIFIED, // Ante 1:1, Play push
        PLAYER_WIN,
        DEALER_WIN,
        TIE
    }

    /* ========== STRUCTS ========== */

    /// @notice Full TCP record — all on-chain fields needed to render a single TCP row in the FE
    struct FullRecord {
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
        BetStatus status;
        Outcome outcome;
        uint8[3] playerCards;
        uint8[3] dealerCards;
        bool isFreeBet;
        uint256 lastRequestAt;
    }

    /* ========== EVENTS ========== */

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 anteAmount,
        uint256 pairPlusAmount
    );
    event PlayerCardsDealt(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 c0,
        uint8 c1,
        uint8 c2,
        uint256 pairPlusPayout
    );
    event PlayChosen(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 playAmount);
    event Folded(uint256 indexed betId, address indexed user);
    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        Outcome outcome,
        uint8 d0,
        uint8 d1,
        uint8 d2,
        uint256 anteAndPlayPayout,
        uint256 anteBonusPayout,
        uint256 totalPayout
    );
    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    /* ========== EXTERNAL ========== */

    /// @notice Places a TCP bet. `isFreeBet=true` pulls Ante (and PairPlus, if non-zero) from
    /// FreeBetsHolder; `false` from the user's wallet. PairPlus must be zero when `isFreeBet`
    /// is true (reverts `PairPlusNotAllowedForFreeBet`). A subsequent makeAction(PLAY) will pull
    /// the Play stake from the same source as the original bet (FBH for free bet, wallet otherwise)
    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 pairPlusAmount,
        address referrer,
        bool isFreeBet
    ) external returns (uint256 betId, uint256 requestId);

    /// @notice Single-selector mid-game dispatcher. Action codes:
    ///   0 = play
    ///   1 = fold
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
            uint256 pairPlusAmount,
            uint256 totalPayout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            Outcome outcome
        );

    function getBetCards(uint256 betId) external view returns (uint8[3] memory playerCards, uint8[3] memory dealerCards);

    function getBetPayouts(
        uint256 betId
    )
        external
        view
        returns (uint256 pairPlusPayout, uint256 anteBonusPayout, uint256 anteAndPlayPayout, uint256 totalPayout);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    /// @notice One-shot full record reader. Returns every on-chain field needed to render a TCP
    /// row in the FE in a single staticcall
    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    /// @notice Next bet id to be assigned. Total placed bets = `nextBetId - 1`. Auto-generated
    /// getter on the public state variable
    function nextBetId() external view returns (uint256);
}
