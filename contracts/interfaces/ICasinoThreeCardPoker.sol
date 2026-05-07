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

    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 pairPlusAmount,
        address referrer
    ) external returns (uint256 betId, uint256 requestId);

    function fold(uint256 betId) external;

    function play(uint256 betId) external returns (uint256 requestId);

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
}
