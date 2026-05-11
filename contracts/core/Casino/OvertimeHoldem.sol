// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoOvertimeHoldem.sol";

/// @title OvertimeHoldem
/// @author Overtime
/// @notice Casino Hold'em-style player-vs-dealer Texas Hold'em. Optional AA Bonus side bet
/// settles on the first 5 cards (player hole + flop). Two-VRF flow keeps dealer's hidden cards
/// and the turn/river out of storage until the player commits to Call (otherwise sophisticated
/// users could read them via `eth_getStorageAt` and exploit perfect info).
/// @dev All funds, randomness, free-bets, and circuit-breaker accounting live in `CasinoCoreV2`.
///
/// Locked paytables (≥2% guaranteed edge — see project memory `casino_edge_floor`):
/// - Ante on player win:  Royal 100:1 / SF 20:1 / 4oK 10:1 / FH 3:1 / Flush 1:1 / Straight 1:1
///   (and 1:1 for any lower hand the player still wins with). Flush dropped from 2:1 to 1:1
///   to clear the 2% element-of-risk floor on the base game.
/// - AA Bonus: Royal 100:1, SF 50:1, 4oK 40:1, FH 30:1, Flush 20:1, Straight 10:1,
///   3oK 8:1, Two Pair 7:1, Pair of Aces 7:1.
contract OvertimeHoldem is
    ICasinoOvertimeHoldem,
    ICasinoGameCallback,
    Initializable,
    ProxyOwned,
    ProxyPausable,
    ProxyReentrancyGuard
{
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    /// @notice After this long in PLAYER_TURN with no fold/call, the resolver role can
    /// `adminForceFold` to release the ante-side reservation. Mitigates a bankroll-grief vector
    /// where a user places a bet, lets VRF1 fulfill, then walks away.
    uint256 public constant PLAYER_TURN_TIMEOUT = 24 hours;

    uint8 private constant DECK_SIZE = 52;

    uint8 private constant HOLE_CARDS = 2;
    uint8 private constant FLOP_CARDS = 3;
    uint8 private constant DEAL1_CARDS = HOLE_CARDS + FLOP_CARDS; // 5: player hole + flop
    uint8 private constant DEAL2_CARDS = HOLE_CARDS + 2; // 4: dealer hole + turn + river

    /// @dev 16 bits per Fisher-Yates swap. 5 swaps × 16 = 80 bits per VRF1 word; 4 swaps
    /// × 16 = 64 bits per VRF2 word. Bias < 0.04% per swap.
    uint8 private constant SHUFFLE_SHIFT_BITS = 16;
    uint64 private constant SHUFFLE_SHIFT_MASK = 0xFFFF;

    // Hand classes (higher numerical value beats lower)
    uint8 private constant CLASS_HIGH_CARD = 0;
    uint8 private constant CLASS_PAIR = 1;
    uint8 private constant CLASS_TWO_PAIR = 2;
    uint8 private constant CLASS_THREE_OF_A_KIND = 3;
    uint8 private constant CLASS_STRAIGHT = 4;
    uint8 private constant CLASS_FLUSH = 5;
    uint8 private constant CLASS_FULL_HOUSE = 6;
    uint8 private constant CLASS_FOUR_OF_A_KIND = 7;
    uint8 private constant CLASS_STRAIGHT_FLUSH = 8;
    uint8 private constant CLASS_ROYAL_FLUSH = 9;

    uint8 private constant RANK_TWO = 2;
    uint8 private constant RANK_FOUR = 4;
    uint8 private constant RANK_ACE = 14;

    /// @notice Dealer qualifies with a pair of fours or better
    uint8 private constant QUALIFIER_MIN_PAIR_RANK = RANK_FOUR;

    // Ante paytable (multiplier on player win): Royal=100, SF=20, 4oK=10, FH=3, Flush=1, Straight=1
    // Default for any lower winning hand = 1:1
    uint256 private constant ANTE_MULT_ROYAL = 100;
    uint256 private constant ANTE_MULT_STRAIGHT_FLUSH = 20;
    uint256 private constant ANTE_MULT_FOUR_OF_A_KIND = 10;
    uint256 private constant ANTE_MULT_FULL_HOUSE = 3;
    uint256 private constant ANTE_MULT_DEFAULT = 1;

    // AA Bonus paytable (5-card hand from player hole + flop)
    uint256 private constant AA_MULT_ROYAL = 100;
    uint256 private constant AA_MULT_STRAIGHT_FLUSH = 50;
    uint256 private constant AA_MULT_FOUR_OF_A_KIND = 40;
    uint256 private constant AA_MULT_FULL_HOUSE = 30;
    uint256 private constant AA_MULT_FLUSH = 20;
    uint256 private constant AA_MULT_STRAIGHT = 10;
    uint256 private constant AA_MULT_THREE_OF_A_KIND = 8;
    uint256 private constant AA_MULT_TWO_PAIR = 7;
    uint256 private constant AA_MULT_PAIR_OF_ACES = 7;

    // Reservation: max possible payout from a single bet at placeBet time.
    // Worst case: player gets a Royal Flush AND AA Bonus shows Royal in first 5 cards.
    //   Ante side max: ante * (1 + 100) = 101 * ante  (Royal payout)
    //   Call side max (when player wins, dealer qualifies): call * 2 = 4 * ante  (call = 2 * ante)
    //   AA Bonus max:  aaBonus * (1 + 100) = 101 * aaBonus
    // Total max payout = 105 * ante + 101 * aaBonus
    uint256 private constant MAX_PAYOUT_ANTE_MULT = 105;
    uint256 private constant MAX_PAYOUT_AA_MULT = 101;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error MaxProfitExceeded();
    error BetNotFound();
    error BetNotOwner();
    error InvalidBetStatus();
    error CancelTimeoutNotReached();
    error PlayerTurnTimeoutNotReached();

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 aaBonusAmount;
        uint256 totalPayout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reservedAnteSide;
        uint256 requestId;
        uint8[2] playerHole;
        uint8[5] community; // [flop0, flop1, flop2, turn, river]
        uint8[2] dealerHole;
        BetStatus status;
        Outcome outcome;
        uint256 aaBonusPayout;
        uint256 antePayout;
        uint256 callPayout;
        // Bet placed with free-bet balance — Ante+AA at place and Call at callBet() pulled from
        // FreeBetsHolder. All settlements route through FBH; referrer payments suppressed on loss
        bool isFreeBet;
    }

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ISportsAMMV2Manager public manager;

    uint256 public nextBetId;

    mapping(uint256 => Bet) internal bets;
    mapping(uint256 => uint256) public requestIdToBetId;
    mapping(address => uint256[]) private userBetIds;

    uint256[40] private __gap;

    /* ========== INITIALIZER ========== */

    function initialize(address _owner, address _core, address _manager) external initializer {
        if (_owner == address(0) || _core == address(0) || _manager == address(0)) revert InvalidAddress();
        setOwner(_owner);
        initNonReentrant();
        core = ICasinoCoreV2(_core);
        manager = ISportsAMMV2Manager(_manager);
        nextBetId = 1;
    }

    /* ========== PLACE / FOLD / CALL ========== */

    /// @notice Places an Overtime Hold'em bet. Triggers VRF1 (player hole + flop)
    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 aaBonusAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, anteAmount, aaBonusAmount, referrer, false);
    }

    /// @inheritdoc ICasinoOvertimeHoldem
    function placeBetWithFreeBet(
        address collateral,
        uint256 anteAmount,
        uint256 aaBonusAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, anteAmount, aaBonusAmount, referrer, true);
    }

    function _placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 aaBonusAmount,
        address referrer,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        if (anteAmount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();

        uint256 anteUsd = core.getUsdValue(collateral, anteAmount);
        if (anteUsd < MIN_BET_USD) revert InvalidAmount();

        // Worst-case house contribution per bet (excluding stake-back) capped against maxProfitUsd
        uint256 worstHouseProfitUsd = anteUsd *
            (MAX_PAYOUT_ANTE_MULT - 3) +
            core.getUsdValue(collateral, aaBonusAmount) *
            (MAX_PAYOUT_AA_MULT - 1);
        if (worstHouseProfitUsd > core.effectiveMaxProfitUsd(address(this))) revert MaxProfitExceeded();

        if (isFreeBet) {
            core.useFreeBet(msg.sender, collateral, anteAmount + aaBonusAmount);
        } else {
            core.pullFromUser(msg.sender, collateral, anteAmount + aaBonusAmount);
        }
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);

        uint256 reservation = anteAmount * MAX_PAYOUT_ANTE_MULT + aaBonusAmount * MAX_PAYOUT_AA_MULT;
        core.reserveOrRevert(collateral, reservation);

        requestId = core.requestRandomWords(1);
        betId = nextBetId++;

        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.anteAmount = anteAmount;
        b.aaBonusAmount = aaBonusAmount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.status = BetStatus.AWAITING_DEAL;
        b.reservedAnteSide = anteAmount * MAX_PAYOUT_ANTE_MULT;
        b.isFreeBet = isFreeBet;

        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);

        emit BetPlaced(betId, requestId, msg.sender, collateral, anteAmount, aaBonusAmount);
    }

    /// @notice User folds — forfeits Ante. AA Bonus already settled on VRF1; this call only
    /// releases the ante-side reservation
    function fold(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        _requireOwnedPlayerTurn(b);
        _doFold(betId, b);
    }

    /// @notice Operator force-fold for a bet stuck in PLAYER_TURN beyond `PLAYER_TURN_TIMEOUT`.
    /// Treats the bet as a fold (ante forfeit) so the ante-side reservation is released and the
    /// bankroll isn't grief-locked by an abandoned mid-game bet. AA Bonus already settled in VRF1.
    function adminForceFold(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + PLAYER_TURN_TIMEOUT) revert PlayerTurnTimeoutNotReached();
        _doFold(betId, b);
    }

    function _doFold(uint256 betId, Bet storage b) internal {
        core.releaseReservation(b.collateral, b.reservedAnteSide);
        b.reservedAnteSide = 0;
        core.recordSettlement(b.collateral, b.anteAmount, 0);
        // Skip referrer payment on free bets — user lost no real funds
        if (!b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, b.anteAmount);
        }

        b.status = BetStatus.RESOLVED;
        b.outcome = Outcome.FOLDED;
        b.resolvedAt = block.timestamp;
        emit Folded(betId, b.user);
    }

    /// @notice User commits to Call — pulls 2× Ante and triggers VRF2 for dealer + turn + river
    /// @dev `call` shadows the language built-in, so the function is named `callBet`
    function callBet(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedPlayerTurn(b);

        uint256 callAmount = b.anteAmount * 2;
        // Free-bet runs draw the call stake from FBH too; if FBH balance < call amount the
        // call reverts and the user must fold instead
        if (b.isFreeBet) {
            core.useFreeBet(b.user, b.collateral, callAmount);
        } else {
            core.pullFromUser(b.user, b.collateral, callAmount);
        }

        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = BetStatus.AWAITING_RESOLVE;
        requestIdToBetId[requestId] = betId;

        emit CallChosen(betId, requestId, b.user, callAmount);
    }

    /// @notice User cancel after timeout from a stuck VRF
    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.AWAITING_DEAL && b.status != BetStatus.AWAITING_RESOLVE) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.AWAITING_DEAL && b.status != BetStatus.AWAITING_RESOLVE) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];

        // Refund: stakes still owed to the user.
        // AWAITING_DEAL → ante + AA Bonus (AA not yet settled).
        // AWAITING_RESOLVE → ante + 2·ante Call stake (AA already settled in VRF1; do NOT refund
        // aaBonus again or the user double-banks the AA stake on a winning AA / recovers a lost AA
        // on a losing AA).
        uint256 refund = b.anteAmount;
        if (b.status == BetStatus.AWAITING_DEAL) {
            refund += b.aaBonusAmount;
        } else {
            refund += b.anteAmount * 2; // call stake
        }

        // Reservation: ante-side still held; aa-bonus side already released on VRF1 fulfill if
        // status is AWAITING_RESOLVE. If still AWAITING_DEAL, both legs remain.
        uint256 reservationToRelease = b.reservedAnteSide +
            (b.status == BetStatus.AWAITING_DEAL ? b.aaBonusAmount * MAX_PAYOUT_AA_MULT : 0);
        b.reservedAnteSide = 0;
        core.releaseReservation(b.collateral, reservationToRelease);

        core.payOut(b.user, b.collateral, refund, b.isFreeBet, refund);

        // `+=` instead of `=`: in AWAITING_RESOLVE, b.totalPayout already holds the AA payout
        // recorded by VRF1; we want the FE-visible total to reflect both. From AWAITING_DEAL the
        // prior value is 0, so the result is identical to `=`.
        b.totalPayout += refund;
        b.status = BetStatus.CANCELLED;
        b.resolvedAt = block.timestamp;
        emit BetCancelled(betId, b.user, refund, adminCancelled);
    }

    /* ========== VRF CALLBACK ========== */

    /// @inheritdoc ICasinoGameCallback
    /// @dev `nonReentrant` defends against malicious-token transfer hooks calling cancelBet
    /// mid-payout for a double-spend
    function onVrfFulfilled(uint256 requestId, uint256[] calldata randomWords) external override nonReentrant {
        if (msg.sender != address(core)) revert InvalidSender();
        uint256 betId = requestIdToBetId[requestId];
        if (betId == 0) return;
        delete requestIdToBetId[requestId];

        Bet storage b = bets[betId];
        if (b.status == BetStatus.AWAITING_DEAL) {
            _onDealFulfilled(betId, b, randomWords[0]);
        } else if (b.status == BetStatus.AWAITING_RESOLVE) {
            _onResolveFulfilled(betId, b, randomWords[0]);
        }
    }

    /// @notice VRF1 fulfillment — deal player hole + flop (5 cards from full deck), settle AA
    /// Bonus on those 5 cards, advance to PLAYER_TURN
    function _onDealFulfilled(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[5] memory five = _drawNFromFullDeck(word, DEAL1_CARDS);
        b.playerHole[0] = five[0];
        b.playerHole[1] = five[1];
        b.community[0] = five[2];
        b.community[1] = five[3];
        b.community[2] = five[4];

        // Settle AA Bonus
        uint256 aaPayout = 0;
        if (b.aaBonusAmount > 0) {
            uint256 aaMult = _aaBonusMultiplier(_evaluateCards(_toMemArray(five)));
            if (aaMult > 0) {
                aaPayout = b.aaBonusAmount * (1 + aaMult);
            }
            core.releaseReservation(b.collateral, b.aaBonusAmount * MAX_PAYOUT_AA_MULT);
            if (aaPayout > 0) {
                core.payOut(b.user, b.collateral, aaPayout, b.isFreeBet, b.aaBonusAmount);
            }
            core.recordSettlement(b.collateral, b.aaBonusAmount, aaPayout);
        }

        b.aaBonusPayout = aaPayout;
        b.totalPayout = aaPayout;
        b.status = BetStatus.PLAYER_TURN;

        emit HoleAndFlopDealt(betId, b.requestId, b.user, five[0], five[1], five[2], five[3], five[4], aaPayout);
    }

    /// @notice VRF2 fulfillment — deal dealer hole + turn + river (4 cards from 47 remaining),
    /// resolve Ante / Call against dealer's best 5-card hand
    function _onResolveFulfilled(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[4] memory four = _drawDealerAndBoardCards(word, b);
        b.dealerHole[0] = four[0];
        b.dealerHole[1] = four[1];
        b.community[3] = four[2]; // turn
        b.community[4] = four[3]; // river

        Resolution memory r = _computeResolution(b);
        uint256 totalSidePayout = r.antePayout + r.callPayout;
        uint256 stakeOut = b.anteAmount * 3; // ante + 2x ante (call)

        core.releaseReservation(b.collateral, b.reservedAnteSide);
        b.reservedAnteSide = 0;

        if (totalSidePayout > 0) {
            core.payOut(b.user, b.collateral, totalSidePayout, b.isFreeBet, stakeOut);
        }
        core.recordSettlement(b.collateral, stakeOut, totalSidePayout);

        // Skip referrer payment on free bets — user lost no real funds
        if (totalSidePayout < stakeOut && !b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, stakeOut - totalSidePayout);
        }

        b.outcome = r.outcome;
        b.antePayout = r.antePayout;
        b.callPayout = r.callPayout;
        b.totalPayout += totalSidePayout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(
            betId,
            b.requestId,
            b.user,
            r.outcome,
            four[0],
            four[1],
            four[2],
            four[3],
            r.antePayout,
            r.callPayout,
            totalSidePayout
        );
    }

    /// @notice Resolution result. Memory-only struct extracted to avoid stack-too-deep
    struct Resolution {
        Outcome outcome;
        uint256 antePayout;
        uint256 callPayout;
    }

    function _computeResolution(Bet storage b) internal view returns (Resolution memory r) {
        // Build 7 cards each for player and dealer (2 hole + 5 community)
        uint8[7] memory pSeven = [
            b.playerHole[0],
            b.playerHole[1],
            b.community[0],
            b.community[1],
            b.community[2],
            b.community[3],
            b.community[4]
        ];
        uint8[7] memory dSeven = [
            b.dealerHole[0],
            b.dealerHole[1],
            b.community[0],
            b.community[1],
            b.community[2],
            b.community[3],
            b.community[4]
        ];

        uint256 pVal = _evaluateCards(_toMemArray7(pSeven));
        uint256 dVal = _evaluateCards(_toMemArray7(dSeven));

        uint256 anteMult = _antePaytableMultiplier(pVal);
        uint256 callAmount = b.anteAmount * 2;

        if (!_dealerQualifies(dVal)) {
            r.outcome = Outcome.DEALER_NOT_QUALIFIED;
            // Ante pays per paytable; Call pushes (returns stake)
            r.antePayout = b.anteAmount * (1 + anteMult);
            r.callPayout = callAmount;
            return r;
        }

        if (pVal > dVal) {
            r.outcome = Outcome.PLAYER_WIN;
            r.antePayout = b.anteAmount * (1 + anteMult);
            r.callPayout = callAmount * 2; // Call 1:1
        } else if (pVal < dVal) {
            r.outcome = Outcome.DEALER_WIN;
            // Ante and Call both lose (paid 0)
        } else {
            r.outcome = Outcome.TIE;
            // Ante & Call both push. Per standard Casino Hold'em, the Ante Bonus paytable pays
            // on top of the push for premium hands (Royal/SF/4oK/FH where mult > 1×). The default
            // 1× is the win-only payout — not a tie bonus — so high-card/pair/straight/flush ties
            // just push.
            r.antePayout = b.anteAmount;
            if (anteMult > ANTE_MULT_DEFAULT) {
                r.antePayout += b.anteAmount * anteMult;
            }
            r.callPayout = callAmount; // push
        }
    }

    /* ========== SHUFFLE / DEAL ========== */

    function _drawNFromFullDeck(uint256 word, uint8 n) internal pure returns (uint8[5] memory out) {
        uint8[] memory deck = _initDeckMask(DECK_SIZE, 0);
        _partialFisherYates(deck, n, word);
        for (uint8 i; i < n; ++i) {
            out[i] = deck[i];
        }
    }

    function _drawDealerAndBoardCards(uint256 word, Bet storage b) internal view returns (uint8[4] memory out) {
        // 47-card deck excluding the 5 cards already revealed (player hole + flop)
        uint64 excludeMask = (uint64(1) << b.playerHole[0]) |
            (uint64(1) << b.playerHole[1]) |
            (uint64(1) << b.community[0]) |
            (uint64(1) << b.community[1]) |
            (uint64(1) << b.community[2]);
        uint8[] memory deck = _initDeckMask(DECK_SIZE - DEAL1_CARDS, excludeMask);
        _partialFisherYates(deck, DEAL2_CARDS, word);
        for (uint8 i; i < DEAL2_CARDS; ++i) {
            out[i] = deck[i];
        }
    }

    /// @notice Builds a deck of `size` cards from 0..51 excluding any card whose bit is set in
    /// `excludeMask`. `size` MUST equal `52 - popcount(excludeMask)`
    function _initDeckMask(uint8 size, uint64 excludeMask) internal pure returns (uint8[] memory deck) {
        deck = new uint8[](size);
        uint8 j;
        for (uint8 c; c < DECK_SIZE; ++c) {
            if ((excludeMask & (uint64(1) << c)) != 0) continue;
            deck[j] = c;
            ++j;
        }
    }

    function _partialFisherYates(uint8[] memory deck, uint8 n, uint256 word) internal pure {
        uint256 len = deck.length;
        uint256 cursor = word;
        for (uint8 i; i < n; ++i) {
            uint256 remaining = len - i;
            uint256 j = i + ((cursor & SHUFFLE_SHIFT_MASK) % remaining);
            cursor >>= SHUFFLE_SHIFT_BITS;
            uint8 tmp = deck[i];
            deck[i] = deck[j];
            deck[j] = tmp;
        }
    }

    /* ========== HAND EVALUATION (5 or 7 cards) ========== */

    /// @notice Evaluates a hand of 5–7 cards and returns the packed best-5 hand value.
    /// Encoding: [class:4][r1:4][r2:4][r3:4][r4:4][r5:4]. Higher = better.
    /// `class` = 0 (HC) .. 9 (Royal). Padded ranks default to 0
    function _evaluateCards(uint8[] memory cards) internal pure returns (uint256) {
        uint8[15] memory rankCount; // ranks 2..14 are used
        uint16 rankMask;
        uint16[4] memory suitRankMask;
        uint8[4] memory suitCount;

        for (uint256 i; i < cards.length; ++i) {
            uint8 r = uint8(cards[i] % 13) + RANK_TWO;
            uint8 s = uint8(cards[i] / 13);
            ++rankCount[r];
            ++suitCount[s];
            rankMask |= uint16(1) << r;
            suitRankMask[s] |= uint16(1) << r;
        }

        // Detect flush
        int8 flushSuit = -1;
        for (uint8 s; s < 4; ++s) {
            if (suitCount[s] >= 5) {
                flushSuit = int8(s);
                break;
            }
        }

        // Straight flush / royal flush
        if (flushSuit >= 0) {
            uint16 fmask = suitRankMask[uint8(flushSuit)];
            uint8 sfTop = _findStraightTop(fmask);
            if (sfTop > 0) {
                if (sfTop == RANK_ACE) {
                    return _pack(CLASS_ROYAL_FLUSH, RANK_ACE, 0, 0, 0, 0);
                }
                return _pack(CLASS_STRAIGHT_FLUSH, sfTop, 0, 0, 0, 0);
            }
        }

        // Group ranks (4oK, 3oK, pairs)
        uint8 fourRank;
        uint8 firstThree;
        uint8 secondThree;
        uint8 firstPair;
        uint8 secondPair;
        for (uint8 step; step < 13; ++step) {
            uint8 r = RANK_ACE - step; // 14 down to 2
            if (rankCount[r] == 4) {
                if (fourRank == 0) fourRank = r;
            } else if (rankCount[r] == 3) {
                if (firstThree == 0) firstThree = r;
                else if (secondThree == 0) secondThree = r;
            } else if (rankCount[r] == 2) {
                if (firstPair == 0) firstPair = r;
                else if (secondPair == 0) secondPair = r;
            }
        }

        // 4 of a kind
        if (fourRank > 0) {
            uint8 kicker = _topNRanksExcluding(rankMask, 1, fourRank, 0, 0)[0];
            return _pack(CLASS_FOUR_OF_A_KIND, fourRank, kicker, 0, 0, 0);
        }

        // Full house (3oK + pair, or two 3oKs — second 3oK serves as a pair)
        if (firstThree > 0 && (secondThree > 0 || firstPair > 0)) {
            uint8 pairRank = secondThree > firstPair ? secondThree : firstPair;
            return _pack(CLASS_FULL_HOUSE, firstThree, pairRank, 0, 0, 0);
        }

        // Flush — top 5 of flush suit
        if (flushSuit >= 0) {
            uint8[5] memory top5 = _topNRanks(suitRankMask[uint8(flushSuit)], 5);
            return _pack(CLASS_FLUSH, top5[0], top5[1], top5[2], top5[3], top5[4]);
        }

        // Straight (any suits)
        uint8 straightTop = _findStraightTop(rankMask);
        if (straightTop > 0) {
            return _pack(CLASS_STRAIGHT, straightTop, 0, 0, 0, 0);
        }

        // 3 of a kind
        if (firstThree > 0) {
            uint8[5] memory kickers = _topNRanksExcluding(rankMask, 2, firstThree, 0, 0);
            return _pack(CLASS_THREE_OF_A_KIND, firstThree, kickers[0], kickers[1], 0, 0);
        }

        // Two pair
        if (firstPair > 0 && secondPair > 0) {
            uint8[5] memory kickers = _topNRanksExcluding(rankMask, 1, firstPair, secondPair, 0);
            return _pack(CLASS_TWO_PAIR, firstPair, secondPair, kickers[0], 0, 0);
        }

        // Pair
        if (firstPair > 0) {
            uint8[5] memory kickers = _topNRanksExcluding(rankMask, 3, firstPair, 0, 0);
            return _pack(CLASS_PAIR, firstPair, kickers[0], kickers[1], kickers[2], 0);
        }

        // High card
        uint8[5] memory hc = _topNRanks(rankMask, 5);
        return _pack(CLASS_HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
    }

    function _findStraightTop(uint16 mask) internal pure returns (uint8) {
        // Broadway down to 6-high. Five consecutive bits ending at `top`
        for (uint8 step; step <= 8; ++step) {
            uint8 top = RANK_ACE - step; // 14, 13, ..., 6
            uint16 fiveMask = uint16(0x1F) << (top - 4);
            if ((mask & fiveMask) == fiveMask) {
                return top;
            }
        }
        // Wheel: A-2-3-4-5 → top reads as 5
        // bits 2..5 = 0x3C; bit 14 = 0x4000
        if ((mask & 0x4000) != 0 && (mask & 0x3C) == 0x3C) {
            return 5;
        }
        return 0;
    }

    function _topNRanks(uint16 mask, uint8 n) internal pure returns (uint8[5] memory out) {
        uint8 idx;
        for (uint8 step; step < 13; ++step) {
            uint8 r = RANK_ACE - step;
            if ((mask & (uint16(1) << r)) != 0) {
                out[idx] = r;
                ++idx;
                if (idx == n) return out;
            }
        }
    }

    function _topNRanksExcluding(
        uint16 mask,
        uint8 n,
        uint8 ex0,
        uint8 ex1,
        uint8 ex2
    ) internal pure returns (uint8[5] memory out) {
        uint16 cleared = mask;
        if (ex0 != 0) cleared &= ~(uint16(1) << ex0);
        if (ex1 != 0) cleared &= ~(uint16(1) << ex1);
        if (ex2 != 0) cleared &= ~(uint16(1) << ex2);
        return _topNRanks(cleared, n);
    }

    function _pack(uint8 class_, uint8 r1, uint8 r2, uint8 r3, uint8 r4, uint8 r5) internal pure returns (uint256) {
        return
            (uint256(class_) << 20) |
            (uint256(r1) << 16) |
            (uint256(r2) << 12) |
            (uint256(r3) << 8) |
            (uint256(r4) << 4) |
            uint256(r5);
    }

    /* ========== DEALER QUALIFIER + PAYTABLE LOOKUPS ========== */

    function _dealerQualifies(uint256 handValue) internal pure returns (bool) {
        uint8 class_ = uint8(handValue >> 20);
        if (class_ > CLASS_PAIR) return true;
        if (class_ == CLASS_PAIR) {
            uint8 primary = uint8((handValue >> 16) & 0xF);
            return primary >= QUALIFIER_MIN_PAIR_RANK;
        }
        return false;
    }

    function _antePaytableMultiplier(uint256 handValue) internal pure returns (uint256) {
        uint8 class_ = uint8(handValue >> 20);
        if (class_ == CLASS_ROYAL_FLUSH) return ANTE_MULT_ROYAL;
        if (class_ == CLASS_STRAIGHT_FLUSH) return ANTE_MULT_STRAIGHT_FLUSH;
        if (class_ == CLASS_FOUR_OF_A_KIND) return ANTE_MULT_FOUR_OF_A_KIND;
        if (class_ == CLASS_FULL_HOUSE) return ANTE_MULT_FULL_HOUSE;
        // Flush, Straight, 3oK, 2P, Pair, HC: 1:1
        return ANTE_MULT_DEFAULT;
    }

    function _aaBonusMultiplier(uint256 handValue) internal pure returns (uint256) {
        uint8 class_ = uint8(handValue >> 20);
        if (class_ == CLASS_ROYAL_FLUSH) return AA_MULT_ROYAL;
        if (class_ == CLASS_STRAIGHT_FLUSH) return AA_MULT_STRAIGHT_FLUSH;
        if (class_ == CLASS_FOUR_OF_A_KIND) return AA_MULT_FOUR_OF_A_KIND;
        if (class_ == CLASS_FULL_HOUSE) return AA_MULT_FULL_HOUSE;
        if (class_ == CLASS_FLUSH) return AA_MULT_FLUSH;
        if (class_ == CLASS_STRAIGHT) return AA_MULT_STRAIGHT;
        if (class_ == CLASS_THREE_OF_A_KIND) return AA_MULT_THREE_OF_A_KIND;
        if (class_ == CLASS_TWO_PAIR) return AA_MULT_TWO_PAIR;
        if (class_ == CLASS_PAIR) {
            uint8 primary = uint8((handValue >> 16) & 0xF);
            if (primary == RANK_ACE) return AA_MULT_PAIR_OF_ACES;
        }
        return 0;
    }

    /* ========== INTERNAL HELPERS ========== */

    function _toMemArray(uint8[5] memory src) internal pure returns (uint8[] memory out) {
        out = new uint8[](5);
        for (uint8 i; i < 5; ++i) out[i] = src[i];
    }

    function _toMemArray7(uint8[7] memory src) internal pure returns (uint8[] memory out) {
        out = new uint8[](7);
        for (uint8 i; i < 7; ++i) out[i] = src[i];
    }

    function _requireOwnedPlayerTurn(Bet storage b) internal view {
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();
    }

    /* ========== VIEWS ========== */

    function getBetBase(
        uint256 betId
    )
        external
        view
        override
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
        )
    {
        Bet storage b = bets[betId];
        return (
            b.user,
            b.collateral,
            b.anteAmount,
            b.aaBonusAmount,
            b.totalPayout,
            b.placedAt,
            b.resolvedAt,
            b.status,
            b.outcome
        );
    }

    function getBetCards(
        uint256 betId
    ) external view override returns (uint8[2] memory playerHole, uint8[5] memory community, uint8[2] memory dealerHole) {
        Bet storage b = bets[betId];
        return (b.playerHole, b.community, b.dealerHole);
    }

    function getBetPayouts(
        uint256 betId
    ) external view override returns (uint256 aaBonusPayout, uint256 antePayout, uint256 callPayout, uint256 totalPayout) {
        Bet storage b = bets[betId];
        return (b.aaBonusPayout, b.antePayout, b.callPayout, b.totalPayout);
    }

    function getUserBetIds(
        address user,
        uint256 offset,
        uint256 limit
    ) external view override returns (uint256[] memory ids) {
        uint256[] storage all = userBetIds[user];
        uint256 len = all.length;
        if (offset >= len) return new uint256[](0);
        uint256 remaining = len - offset;
        uint256 count = remaining < limit ? remaining : limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = all[len - 1 - offset - i];
        }
    }

    function getRecentBetIds(uint256 offset, uint256 limit) external view override returns (uint256[] memory ids) {
        uint256 latest = nextBetId - 1;
        if (offset >= latest) return new uint256[](0);
        uint256 start = latest - offset;
        uint256 count = start < limit ? start : limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = start - i;
        }
    }

    /* ========== ADMIN ========== */

    function setCore(address _core) external onlyOwner {
        if (_core == address(0)) revert InvalidAddress();
        core = ICasinoCoreV2(_core);
    }

    function setManager(address _manager) external onlyOwner {
        if (_manager == address(0)) revert InvalidAddress();
        manager = ISportsAMMV2Manager(_manager);
    }

    function setPausedByRole(bool _paused) external onlyPauser {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) lastPauseTime = block.timestamp;
            emit PauseChanged(_paused);
        }
    }

    /* ========== MODIFIERS ========== */

    function _requireRole(ISportsAMMV2Manager.Role role) internal view {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, role)) revert InvalidSender();
    }

    modifier onlyResolver() {
        _requireRole(ISportsAMMV2Manager.Role.MARKET_RESOLVING);
        _;
    }
    modifier onlyPauser() {
        _requireRole(ISportsAMMV2Manager.Role.TICKET_PAUSER);
        _;
    }
}
