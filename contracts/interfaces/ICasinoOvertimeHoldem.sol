// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoOvertimeHoldem
/// @author Overtime
interface ICasinoOvertimeHoldem {
    /* ========== ENUMS ========== */

    enum BetStatus {
        NONE,
        AWAITING_DEAL, // VRF1 in flight
        PLAYER_TURN, // hole + flop revealed; AA Bonus settled; awaiting fold/call
        AWAITING_RESOLVE, // Call chosen; VRF2 in flight (dealer hole + turn + river)
        RESOLVED,
        CANCELLED
    }

    enum Outcome {
        NONE,
        FOLDED,
        DEALER_NOT_QUALIFIED, // Ante pays per paytable, Call pushes
        PLAYER_WIN, // Ante pays per paytable, Call 1:1
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
        uint256 aaBonusAmount
    );

    event HoleAndFlopDealt(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 hole0,
        uint8 hole1,
        uint8 flop0,
        uint8 flop1,
        uint8 flop2,
        uint256 aaBonusPayout
    );

    event CallChosen(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint256 callAmount);

    event Folded(uint256 indexed betId, address indexed user);

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        Outcome outcome,
        uint8 dealerHole0,
        uint8 dealerHole1,
        uint8 turn,
        uint8 river,
        uint256 antePayout,
        uint256 callPayout,
        uint256 totalPayout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    /* ========== EXTERNAL ========== */

    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 aaBonusAmount,
        address referrer
    ) external returns (uint256 betId, uint256 requestId);

    function fold(uint256 betId) external;

    function callBet(uint256 betId) external returns (uint256 requestId);

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
            uint256 aaBonusAmount,
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
    ) external view returns (uint256 aaBonusPayout, uint256 antePayout, uint256 callPayout, uint256 totalPayout);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);
}
