// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoVideoPoker
/// @author Overtime
/// @notice Jacks-or-Better Video Poker (8/5 paytable, single-coin only). Player posts an ante,
/// VRF1 deals five cards. Player sees the cards, picks a 5-bit `holdMask`, and calls `draw`
/// which triggers VRF2 to replace non-held cards. The resulting 5-card hand is then scored
/// against the paytable and resolved.
///
/// Paytable (multiplier on stake; lose otherwise):
///   Royal Flush    : 500x
///   Straight Flush : 50x
///   Four of a Kind : 25x
///   Full House     : 8x
///   Flush          : 5x
///   Straight       : 4x
///   Three of a Kind: 3x
///   Two Pair       : 2x
///   Jacks-or-better: 1x  (pair of J/Q/K/A only — pairs of 2..10 lose)
interface ICasinoVideoPoker {
    /* ========== ENUMS ========== */

    enum BetStatus {
        NONE,
        AWAITING_DEAL, // VRF1 in flight — initial 5-card deal
        PLAYER_TURN, // 5 cards dealt, awaiting draw(holdMask)
        AWAITING_DRAW, // VRF2 in flight — replacement cards
        RESOLVED,
        CANCELLED
    }

    /// @notice Final hand class (matches OvertimeHoldem encoding). Used in the resolve event
    /// so the FE doesn't have to re-evaluate the cards client-side
    enum HandClass {
        HIGH_CARD,
        PAIR, // any pair (winning only if rank >= Jack)
        TWO_PAIR,
        THREE_OF_A_KIND,
        STRAIGHT,
        FLUSH,
        FULL_HOUSE,
        FOUR_OF_A_KIND,
        STRAIGHT_FLUSH,
        ROYAL_FLUSH
    }

    /* ========== STRUCTS ========== */

    /// @notice Full Video Poker record (Jacks-or-Better, single hand)
    struct FullRecord {
        uint256 betId;
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 resolvedAt;
        BetStatus status;
        HandClass handClass;
        uint8 holdMask; // 5-bit hold mask committed at draw()
        uint256 multiplier; // paytable multiplier on the resolved hand (0 if lost)
        uint8[5] initialCards; // cards from VRF1 (zeroed until AWAITING_DEAL fulfilled)
        uint8[5] finalCards; // cards after the draw replacements (zeroed until RESOLVED)
        bool isFreeBet;
        uint256 lastRequestAt;
    }

    /* ========== EVENTS ========== */

    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        address collateral,
        uint256 amount
    );

    event InitialDealRevealed(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 card0,
        uint8 card1,
        uint8 card2,
        uint8 card3,
        uint8 card4
    );

    event DrawRequested(uint256 indexed betId, uint256 indexed requestId, address indexed user, uint8 holdMask);

    event BetResolved(
        uint256 indexed betId,
        uint256 indexed requestId,
        address indexed user,
        uint8 finalCard0,
        uint8 finalCard1,
        uint8 finalCard2,
        uint8 finalCard3,
        uint8 finalCard4,
        HandClass handClass,
        uint256 multiplier,
        uint256 payout
    );

    event BetCancelled(uint256 indexed betId, address indexed user, uint256 refundAmount, bool adminCancelled);

    /* ========== EXTERNAL ========== */

    /// @notice Places a Video Poker bet. Pulls `amount` upfront and triggers VRF1 to deal the
    /// initial 5 cards. `isFreeBet=true` pulls the stake from FreeBetsHolder and routes the
    /// payout back to FBH on resolve / cancel; `false` pulls from the user's wallet. Single
    /// canonical entry
    function placeBet(
        address collateral,
        uint256 amount,
        address referrer,
        bool isFreeBet
    ) external returns (uint256 betId, uint256 requestId);

    /// @notice Commits the player's hold decision (low 5 bits of `holdMask` — bit i = keep card i)
    /// and triggers VRF2 to deal replacements. `holdMask == 0` discards all five; `holdMask == 31`
    /// keeps all five (VRF2 still fires but produces no swaps and resolves on the original hand)
    function draw(uint256 betId, uint8 holdMask) external returns (uint256 requestId);

    /// @notice Operator-only cancel — only path to resolve stuck or stalled bets. User-callable
    /// cancel was removed to close a VRF mempool front-run surface
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
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            HandClass handClass,
            uint8 holdMask,
            uint256 multiplier
        );

    function getBetCards(uint256 betId) external view returns (uint8[5] memory initialCards, uint8[5] memory finalCards);

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function getRecentBetIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    /// @notice One-shot full record reader. Single staticcall, all FE-renderable fields
    function getFullRecord(uint256 betId) external view returns (FullRecord memory);

    function nextBetId() external view returns (uint256);
}
