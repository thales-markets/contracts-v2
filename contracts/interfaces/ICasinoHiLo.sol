// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoHiLo
/// @author Overtime
/// @notice Above/below 8 card-guess run with cashout. Each round the player picks ABOVE or
/// BELOW the rank-6 midpoint (card "8"); a fresh card is drawn from a 52-card deck; correct
/// guesses multiply the running multiplier by a constant factor; wrong guess loses the bet;
/// cashout pays `bet * multiplier`. Drawing card "8" is a push (mult unchanged, run continues)
interface ICasinoHiLo {
    enum BetStatus {
        NONE,
        PLAYER_TURN,
        AWAITING_NEXT_CARD,
        RESOLVED,
        CANCELLED
    }

    enum Outcome {
        NONE,
        CASHED_OUT,
        WRONG_GUESS
    }

    enum Direction {
        ABOVE, // bet that next card's rank > MIDPOINT_RANK (i.e., card 9 or higher)
        BELOW // bet that next card's rank < MIDPOINT_RANK (i.e., card 7 or lower)
    }

    /// @notice Per-turn outcome stored alongside the drawn card. NONE only exists for the
    /// default-zero readability of the storage slot — never written
    enum CardOutcome {
        NONE,
        HIT, // correct guess: multiplier advanced
        PUSH, // drew the midpoint card (8): multiplier unchanged, run continues
        BUST // wrong guess: bet resolved, multiplier frozen at pre-bust value in `multipliersE18`
    }

    /// @notice Full Hi-Lo record. For the per-turn history (directions / cards / outcomes /
    /// multipliers per turn), call `getBetCards(betId)` directly — kept off this struct so reads
    /// stay bounded. Two reads per bet for the full picture, but each is a single staticcall
    struct FullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        BetStatus status;
        Outcome outcome;
        uint8 lastCard; // last drawn card; 0xFF if no card has been drawn yet
        uint256 currentMultiplierE18;
        uint8 guessCount;
        uint8 correctCount;
        uint8 pushCount;
        bool isFreeBet;
    }

    event BetPlaced(uint256 indexed betId, address indexed user, address collateral, uint256 amount);

    event GuessChosen(uint256 indexed betId, uint256 indexed requestId, address indexed user, Direction direction);

    event NextCardDealt(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 newCard,
        bool wasCorrect,
        bool wasPush,
        uint256 newMultiplierE18
    );

    event CashedOut(uint256 indexed betId, address indexed user, uint256 multiplierE18, uint256 payout);

    event BetResolved(uint256 indexed betId, address indexed user, Outcome outcome, uint256 payout);

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    /// @notice Places a HiLo bet and submits the first guess in a single transaction. The bet
    /// starts in AWAITING_NEXT_CARD with the first VRF request already in flight. Subsequent
    /// rounds use `makeAction(betId, action)` once the bet returns to PLAYER_TURN.
    /// `isFreeBet=true` pulls the stake from FreeBetsHolder, `false` from the user's wallet
    function placeBet(
        address collateral,
        uint256 amount,
        address referrer,
        Direction firstDirection,
        bool isFreeBet
    ) external returns (uint256 betId, uint256 requestId);

    /// @notice Single-selector mid-game dispatcher. Action codes:
    ///   0 = guess ABOVE
    ///   1 = guess BELOW
    ///   2 = cashout
    function makeAction(uint256 betId, uint8 action) external returns (uint256 requestId);

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
            Outcome outcome
        );

    function getBetState(
        uint256 betId
    )
        external
        view
        returns (uint8 lastCard, uint256 currentMultiplierE18, uint8 guessCount, uint8 correctCount, uint8 pushCount);

    /// @notice Returns the full per-turn history for `betId`. The four arrays are parallel and
    /// aligned (one entry per resolved card), except `directions` which has one entry per
    /// submitted guess: while VRF for the latest guess is in flight, `directions.length ==
    /// cards.length + 1`. The bust branch writes the pre-bust (frozen) multiplier so the FE can
    /// render "you were at Nx before busting"
    function getBetCards(
        uint256 betId
    )
        external
        view
        returns (
            uint8[] memory directions,
            uint8[] memory cards,
            uint8[] memory outcomes, // CardOutcome cast to uint8
            uint256[] memory multipliersE18
        );

    /// @notice Constant per-correct-guess multiplier factor: `(12 - 13*HE) / 6` in 1e18 precision
    function multiplierFactorE18() external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    /// @notice One-shot full record reader. Per-turn history is intentionally not bundled here —
    /// call `getBetCards(betId)` for that
    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    function nextBetId() external view returns (uint256);
}
