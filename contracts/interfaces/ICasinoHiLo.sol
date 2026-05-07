// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoHiLo
/// @author Overtime
interface ICasinoHiLo {
    enum BetStatus {
        NONE,
        AWAITING_FIRST_CARD,
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
        HIGHER,
        LOWER
    }

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount
    );

    event FirstCardDealt(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 card);

    event GuessChosen(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        Direction direction,
        uint8 currentCard
    );

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

    function placeBet(
        address collateral,
        uint256 amount,
        address referrer
    ) external returns (uint256 betId, uint256 requestId);

    function guess(uint256 betId, Direction direction) external returns (uint256 requestId);

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
            Outcome outcome
        );

    function getBetState(
        uint256 betId
    )
        external
        view
        returns (uint8 currentCard, uint256 currentMultiplierE18, uint8 guessCount, uint8 correctCount, uint8 pushCount);

    function multiplierFactorE18(Direction direction, uint8 cardRank) external view returns (uint256);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);
}
