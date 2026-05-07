// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoThreeCardPoker.sol";

/// @title ThreeCardPoker
/// @author Overtime
/// @notice Single-player Three Card Poker against the dealer. Optional Pair Plus side bet.
/// Uses two VRF requests per round so dealer cards are not on-chain (and not exploitable via
/// `eth_getStorageAt`) before the player commits to Play vs Fold.
/// @dev All funds, randomness, free-bets and circuit-breaker accounting live in `CasinoCoreV2`.
/// This contract is pure game logic + lifecycle state.
///
/// Locked paytables (≥2% guaranteed edge):
/// - Ante Bonus: Straight Flush 5:1, Three of a Kind 4:1, Straight 1:1
/// - Pair Plus:  Straight Flush 40:1, Three of a Kind 30:1, Straight 6:1, Flush 4:1, Pair 1:1
contract ThreeCardPoker is
    ICasinoThreeCardPoker,
    ICasinoGameCallback,
    Initializable,
    ProxyOwned,
    ProxyPausable,
    ProxyReentrancyGuard
{
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 private constant USDC_UNIT = 1e6;

    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant DECK_SIZE = 52;
    uint8 private constant CARDS_PER_HAND = 3;

    /// @dev Bits consumed per Fisher-Yates swap. 16 bits gives 0..65535; modulo 52 leaves a
    /// residual bias of ~0.018% per swap (12 of 65536 outcomes). Negligible vs the 2% edge floor.
    /// 3 swaps × 16 bits = 48 bits per shuffle, well within one VRF word
    uint8 private constant SHUFFLE_SHIFT_BITS = 16;
    uint64 private constant SHUFFLE_SHIFT_MASK = 0xFFFF;

    // Rank index in 2..14 (2 = deuce, 14 = ace)
    uint8 private constant RANK_TWO = 2;
    uint8 private constant RANK_THREE = 3;
    uint8 private constant RANK_QUEEN = 12;
    uint8 private constant RANK_ACE = 14;

    // Dealer qualifier: Q-high or better
    uint8 private constant QUALIFIER_RANK = RANK_QUEEN;

    // Hand classes (numeric value matters: higher class beats lower regardless of kickers)
    uint8 private constant CLASS_HIGH_CARD = 0;
    uint8 private constant CLASS_PAIR = 1;
    uint8 private constant CLASS_FLUSH = 2;
    uint8 private constant CLASS_STRAIGHT = 3;
    uint8 private constant CLASS_THREE_OF_A_KIND = 4;
    uint8 private constant CLASS_STRAIGHT_FLUSH = 5;

    // Ante Bonus paytable (multiples of Ante; not stake-returning, pure bonus)
    uint256 private constant ANTE_BONUS_STRAIGHT_FLUSH = 5;
    uint256 private constant ANTE_BONUS_THREE_OF_A_KIND = 4;
    uint256 private constant ANTE_BONUS_STRAIGHT = 1;

    // Pair Plus paytable (multiples of pair-plus stake; payout = stake * (mult + 1) on win)
    uint256 private constant PAIR_PLUS_STRAIGHT_FLUSH = 40;
    uint256 private constant PAIR_PLUS_THREE_OF_A_KIND = 30;
    uint256 private constant PAIR_PLUS_STRAIGHT = 6;
    uint256 private constant PAIR_PLUS_FLUSH = 4;
    uint256 private constant PAIR_PLUS_PAIR = 1;

    // Reservation: max possible total payout from a single bet at placeBet time.
    //   Ante side max:      ante * (1 + 1 + 5) = 7 * ante     (1 stake-back + 1 Play 1:1 + 5 Ante Bonus SF)
    //   Wait — ante 1:1 is also 1*ante on top of the stake = 2*ante payout. Same for Play.
    //   Recompute:
    //     Ante stake-back + Ante 1:1 win + Play stake-back + Play 1:1 win + Ante Bonus SF (5x)
    //     = ante + ante + ante + ante + 5*ante = 9 * ante
    //   Pair Plus side max: pairPlus * (1 + 40) = 41 * pairPlus
    uint256 private constant MAX_PAYOUT_ANTE_MULT = 9;
    uint256 private constant MAX_PAYOUT_PAIR_PLUS_MULT = 41;

    // Reservation portion released after pair plus settles (the unused PP slice is freed).
    // Worst-case PP payout already released; remaining liability covers ante side only (9*ante).

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

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 pairPlusAmount;
        uint256 totalPayout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reservedAnteSide; // ante-side reservation still held in core; freed at resolve/fold
        uint256 requestId;
        uint8[3] playerCards;
        uint8[3] dealerCards;
        BetStatus status;
        Outcome outcome;
        // payout breakdown (for FE clarity, populated as each leg settles)
        uint256 pairPlusPayout;
        uint256 anteBonusPayout;
        uint256 anteAndPlayPayout;
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

    /* ========== PLACE / PLAY / FOLD ========== */

    /// @notice Places a Three Card Poker bet (Ante required, Pair Plus optional). Triggers VRF1
    /// for player cards. Player and dealer hands are dealt from independent shuffles to keep
    /// dealer cards off-chain until the player commits to Play
    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 pairPlusAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        if (anteAmount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();

        uint256 anteUsd = core.getUsdValue(collateral, anteAmount);
        if (anteUsd < MIN_BET_USD) revert InvalidAmount();

        // Cap the per-bet profit (USD) — at risk on the ante side is up to ANTE_BONUS_SF + Play
        // 1:1 = 6x ante in pure house contribution (excluding Pair Plus, which has its own ceiling
        // implicitly capped by core's per-bet limit applied to the worst-case payout)
        uint256 worstHouseProfitUsd = anteUsd *
            (MAX_PAYOUT_ANTE_MULT - 2) +
            core.getUsdValue(collateral, pairPlusAmount) *
            (MAX_PAYOUT_PAIR_PLUS_MULT - 1);
        if (worstHouseProfitUsd > core.maxProfitUsd()) revert MaxProfitExceeded();

        // Pull Ante + Pair Plus from user via core (single approval target)
        core.pullFromUser(msg.sender, collateral, anteAmount + pairPlusAmount);

        // Set referrer (no-op if zero / no referrals contract wired)
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);

        // Reserve worst-case payout = 9*ante + 41*pairPlus
        uint256 reservation = anteAmount * MAX_PAYOUT_ANTE_MULT + pairPlusAmount * MAX_PAYOUT_PAIR_PLUS_MULT;
        core.reserveOrRevert(collateral, reservation);

        // Request VRF1 (player cards)
        requestId = core.requestRandomWords(1);

        betId = nextBetId++;
        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.anteAmount = anteAmount;
        b.pairPlusAmount = pairPlusAmount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.status = BetStatus.AWAITING_DEAL;
        b.reservedAnteSide = anteAmount * MAX_PAYOUT_ANTE_MULT;

        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);

        emit BetPlaced(betId, requestId, msg.sender, collateral, anteAmount, pairPlusAmount);
    }

    /// @notice User folds — forfeits Ante, no Play stake taken. Pair Plus has already settled in
    /// VRF1 fulfillment; this call only releases the remaining ante-side reservation
    function fold(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        _requireOwnedPlayerTurn(b);

        // Release ante-side reservation; ante itself stays in bankroll (forfeit)
        core.releaseReservation(b.collateral, b.reservedAnteSide);
        b.reservedAnteSide = 0;

        // Record settlement: stake = ante (forfeit), payout = 0 → house gains ante in P&L gauge.
        // Pair Plus has its own settlement already recorded in VRF1 fulfill
        core.recordSettlement(b.collateral, b.anteAmount, 0);

        // Best-effort referrer payout (non-free-bet only)
        core.payReferrer(b.user, b.collateral, b.anteAmount);

        b.status = BetStatus.RESOLVED;
        b.outcome = Outcome.FOLDED;
        b.resolvedAt = block.timestamp;
        emit Folded(betId, b.user);
    }

    /// @notice User commits to Play — pulls additional Ante-sized stake and triggers VRF2
    /// for dealer cards. Dealer cards are dealt from a fresh 49-card deck (excluding the player's
    /// 3 cards) so no duplicates can occur
    function play(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedPlayerTurn(b);

        // Pull Play stake (= Ante) from user via core
        core.pullFromUser(b.user, b.collateral, b.anteAmount);

        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = BetStatus.AWAITING_RESOLVE;
        requestIdToBetId[requestId] = betId;

        emit PlayChosen(betId, requestId, b.user, b.anteAmount);
    }

    /// @notice User-initiated cancel for a bet that's been waiting on VRF longer than the
    /// `cancelTimeout` configured in core. Refunds whatever stakes have been pulled
    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.AWAITING_DEAL && b.status != BetStatus.AWAITING_RESOLVE) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    /// @notice Operator emergency cancel — bypasses timeout
    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.AWAITING_DEAL && b.status != BetStatus.AWAITING_RESOLVE) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];

        // Refund: anything we pulled in. AWAITING_DEAL → ante + pairPlus; AWAITING_RESOLVE → also Play stake.
        uint256 refund = b.anteAmount + b.pairPlusAmount;
        if (b.status == BetStatus.AWAITING_RESOLVE) refund += b.anteAmount;

        // Release reservation: ante-side still pending; pair-plus reservation already released on
        // VRF1 fulfill if status == AWAITING_RESOLVE; if AWAITING_DEAL, both legs still reserved.
        uint256 reservationToRelease = b.reservedAnteSide +
            (b.status == BetStatus.AWAITING_DEAL ? b.pairPlusAmount * MAX_PAYOUT_PAIR_PLUS_MULT : 0);
        b.reservedAnteSide = 0;
        core.releaseReservation(b.collateral, reservationToRelease);

        // Refund stakes
        core.payOut(b.user, b.collateral, refund, false, refund);

        b.totalPayout = refund;
        b.status = BetStatus.CANCELLED;
        b.resolvedAt = block.timestamp;
        emit BetCancelled(betId, b.user, refund, adminCancelled);
    }

    /* ========== VRF CALLBACK ========== */

    /// @inheritdoc ICasinoGameCallback
    /// @dev `nonReentrant` blocks re-entry into THIS contract's own user-facing functions
    /// (placeBet/fold/play/cancelBet) during fulfillment, defending against malicious-token
    /// transfer hooks that could otherwise call cancelBet mid-payout for a double-spend
    function onVrfFulfilled(uint256 requestId, uint256[] calldata randomWords) external override nonReentrant {
        if (msg.sender != address(core)) revert InvalidSender();
        uint256 betId = requestIdToBetId[requestId];
        if (betId == 0) return; // already cancelled / unknown
        delete requestIdToBetId[requestId];

        Bet storage b = bets[betId];
        if (b.status == BetStatus.AWAITING_DEAL) {
            _onDealFulfilled(betId, b, randomWords[0]);
        } else if (b.status == BetStatus.AWAITING_RESOLVE) {
            _onResolveFulfilled(betId, b, randomWords[0]);
        }
        // any other state: stale callback, ignore
    }

    /// @notice VRF1 fulfillment — deal player cards, settle Pair Plus, advance to PLAYER_TURN
    function _onDealFulfilled(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[3] memory pCards = _drawThreeCards(word);
        b.playerCards = pCards;

        // Settle Pair Plus (independent of dealer / fold)
        uint256 ppPayout = 0;
        if (b.pairPlusAmount > 0) {
            (uint8 pClass, ) = _evaluate3Card(pCards);
            uint256 ppMult = _pairPlusMultiplier(pClass);
            if (ppMult > 0) {
                // Pay Pair Plus stake-back + multiplier × stake = stake * (1 + mult)
                ppPayout = b.pairPlusAmount * (1 + ppMult);
            }
            // Release pair-plus side reservation in full (whether won or lost)
            core.releaseReservation(b.collateral, b.pairPlusAmount * MAX_PAYOUT_PAIR_PLUS_MULT);
            if (ppPayout > 0) {
                core.payOut(b.user, b.collateral, ppPayout, false, b.pairPlusAmount);
            }
            // Settlement accounting for Pair Plus leg
            core.recordSettlement(b.collateral, b.pairPlusAmount, ppPayout);
        }

        b.pairPlusPayout = ppPayout;
        b.totalPayout = ppPayout;
        b.status = BetStatus.PLAYER_TURN;

        emit PlayerCardsDealt(betId, b.requestId, b.user, pCards[0], pCards[1], pCards[2], ppPayout);
    }

    /// @notice Outcome computation result. Lives in memory only — extracted to keep
    /// `_onResolveFulfilled` below the stack-too-deep threshold without `viaIR`
    struct Resolution {
        Outcome outcome;
        uint256 anteAndPlayPayout;
        uint256 anteBonusPayout;
    }

    /// @notice VRF2 fulfillment — deal dealer cards (excluding player's), settle Ante / Play /
    /// Ante Bonus and finalize the bet
    function _onResolveFulfilled(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[3] memory dCards = _drawThreeDealerCards(word, b.playerCards);
        b.dealerCards = dCards;

        Resolution memory r = _computeResolution(b.playerCards, dCards, b.anteAmount);
        uint256 totalSideAPayout = r.anteAndPlayPayout + r.anteBonusPayout;
        uint256 stakeOut = b.anteAmount * 2;

        core.releaseReservation(b.collateral, b.reservedAnteSide);
        b.reservedAnteSide = 0;

        if (totalSideAPayout > 0) {
            core.payOut(b.user, b.collateral, totalSideAPayout, false, stakeOut);
        }
        core.recordSettlement(b.collateral, stakeOut, totalSideAPayout);

        if (totalSideAPayout < stakeOut) {
            core.payReferrer(b.user, b.collateral, stakeOut - totalSideAPayout);
        }

        b.outcome = r.outcome;
        b.anteBonusPayout = r.anteBonusPayout;
        b.anteAndPlayPayout = r.anteAndPlayPayout;
        b.totalPayout += totalSideAPayout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(
            betId,
            b.requestId,
            b.user,
            r.outcome,
            dCards[0],
            dCards[1],
            dCards[2],
            r.anteAndPlayPayout,
            r.anteBonusPayout,
            totalSideAPayout
        );
    }

    function _computeResolution(
        uint8[3] memory pCards,
        uint8[3] memory dCards,
        uint256 anteAmount
    ) internal pure returns (Resolution memory r) {
        (uint8 pClass, uint32 pTie) = _evaluate3Card(pCards);
        (uint8 dClass, uint32 dTie) = _evaluate3Card(dCards);

        // Ante Bonus: pure bonus on top of Ante side, regardless of dealer outcome
        r.anteBonusPayout = _anteBonusMultiplier(pClass) * anteAmount;

        if (!_dealerQualifies(dClass, dCards)) {
            // Ante 1:1, Play push: 2x ante (stake + win) + ante (Play stake-back) = 3x ante
            r.outcome = Outcome.DEALER_NOT_QUALIFIED;
            r.anteAndPlayPayout = anteAmount * 3;
            return r;
        }

        int8 cmp = _compareHands(pClass, pTie, dClass, dTie);
        if (cmp > 0) {
            r.outcome = Outcome.PLAYER_WIN;
            r.anteAndPlayPayout = anteAmount * 4; // ante 2x + play 2x
        } else if (cmp < 0) {
            r.outcome = Outcome.DEALER_WIN;
            // anteAndPlayPayout = 0
        } else {
            r.outcome = Outcome.TIE;
            r.anteAndPlayPayout = anteAmount * 2; // both push
        }
    }

    /* ========== SHUFFLE / DEAL ========== */

    /// @notice Sentinel used to indicate "no exclusion" in `_initDeck`. Must be outside
    /// the valid card range 0..51 (255 = max uint8 chosen for clarity)
    uint8 private constant NO_EXCLUSION = 255;

    /// @notice Draws 3 unique cards from a 52-card deck via partial Fisher-Yates seeded by `word`
    function _drawThreeCards(uint256 word) internal pure returns (uint8[3] memory out) {
        uint8[] memory deck = _initDeck(DECK_SIZE, NO_EXCLUSION, NO_EXCLUSION, NO_EXCLUSION, NO_EXCLUSION);
        _partialFisherYates(deck, CARDS_PER_HAND, word);
        out[0] = deck[0];
        out[1] = deck[1];
        out[2] = deck[2];
    }

    /// @notice Draws 3 unique dealer cards from a 49-card deck excluding the 3 player cards
    function _drawThreeDealerCards(uint256 word, uint8[3] memory excluded) internal pure returns (uint8[3] memory out) {
        uint8[] memory deck = _initDeck(DECK_SIZE - CARDS_PER_HAND, excluded[0], excluded[1], excluded[2], NO_EXCLUSION);
        _partialFisherYates(deck, CARDS_PER_HAND, word);
        out[0] = deck[0];
        out[1] = deck[1];
        out[2] = deck[2];
    }

    /// @notice Builds a deck of size `size`, optionally skipping `ex0..ex3` (sentinel:
    /// `NO_EXCLUSION` = 255). Used both for the full 52 and for the 49-card
    /// "exclude player cards" deck. `size` MUST equal `52 - (number of non-sentinel exclusions)`
    function _initDeck(uint8 size, uint8 ex0, uint8 ex1, uint8 ex2, uint8 ex3) internal pure returns (uint8[] memory deck) {
        deck = new uint8[](size);
        uint8 j = 0;
        for (uint8 c = 0; c < DECK_SIZE; ++c) {
            if (c == ex0 || c == ex1 || c == ex2 || c == ex3) continue;
            deck[j] = c;
            ++j;
        }
        // assertion: j == size; skipped to save gas — caller responsibility
    }

    /// @notice Performs `n` Fisher-Yates swaps on `deck` driven by `word`. The first `n` slots
    /// of `deck` end up containing `n` unique elements
    function _partialFisherYates(uint8[] memory deck, uint8 n, uint256 word) internal pure {
        uint256 len = deck.length;
        uint256 cursor = word;
        for (uint8 i = 0; i < n; ++i) {
            uint256 remaining = len - i;
            uint256 j = i + ((cursor & SHUFFLE_SHIFT_MASK) % remaining);
            cursor >>= SHUFFLE_SHIFT_BITS;
            // swap deck[i] and deck[j]
            uint8 tmp = deck[i];
            deck[i] = deck[j];
            deck[j] = tmp;
        }
    }

    /* ========== HAND EVALUATION ========== */

    /// @notice Evaluates a 3-card hand. Returns hand class (0..5) and a tie-breaker uint32 that
    /// orders correctly within the same class (higher is better)
    function _evaluate3Card(uint8[3] memory cards) internal pure returns (uint8 class_, uint32 tieBreaker) {
        // ranks 2..14, suits 0..3
        uint8 r0 = uint8(cards[0] % 13) + RANK_TWO;
        uint8 r1 = uint8(cards[1] % 13) + RANK_TWO;
        uint8 r2 = uint8(cards[2] % 13) + RANK_TWO;
        uint8 s0 = uint8(cards[0] / 13);
        uint8 s1 = uint8(cards[1] / 13);
        uint8 s2 = uint8(cards[2] / 13);

        // sort ranks descending into (rHi, rMid, rLo)
        (uint8 rHi, uint8 rMid, uint8 rLo) = _sortDesc3(r0, r1, r2);

        bool isFlush = (s0 == s1 && s1 == s2);

        // straight detection on sorted ranks: consecutive (rHi - rLo == 2) OR ace-low wheel A-2-3
        bool isStraight = false;
        uint8 straightTopRank = rHi;
        if (rHi - rLo == 2 && rHi - rMid == 1) {
            isStraight = true;
        } else if (rHi == RANK_ACE && rMid == RANK_THREE && rLo == RANK_TWO) {
            // ace-low wheel: top card is the 3 for tie-break purposes
            isStraight = true;
            straightTopRank = RANK_THREE;
        }

        // three of a kind
        if (rHi == rLo) {
            class_ = CLASS_THREE_OF_A_KIND;
            tieBreaker = uint32(rHi);
            return (class_, tieBreaker);
        }
        // straight flush
        if (isStraight && isFlush) {
            class_ = CLASS_STRAIGHT_FLUSH;
            tieBreaker = uint32(straightTopRank);
            return (class_, tieBreaker);
        }
        // straight (non-flush)
        if (isStraight) {
            class_ = CLASS_STRAIGHT;
            tieBreaker = uint32(straightTopRank);
            return (class_, tieBreaker);
        }
        // flush (non-straight)
        if (isFlush) {
            class_ = CLASS_FLUSH;
            tieBreaker = (uint32(rHi) << 16) | (uint32(rMid) << 8) | uint32(rLo);
            return (class_, tieBreaker);
        }
        // pair: any two equal (since not all three equal — that'd be 3 of a kind)
        if (rHi == rMid) {
            class_ = CLASS_PAIR;
            tieBreaker = (uint32(rHi) << 8) | uint32(rLo); // pair rank, then kicker
            return (class_, tieBreaker);
        }
        if (rMid == rLo) {
            class_ = CLASS_PAIR;
            tieBreaker = (uint32(rMid) << 8) | uint32(rHi); // pair rank, then kicker
            return (class_, tieBreaker);
        }
        // high card
        class_ = CLASS_HIGH_CARD;
        tieBreaker = (uint32(rHi) << 16) | (uint32(rMid) << 8) | uint32(rLo);
    }

    function _sortDesc3(uint8 a, uint8 b, uint8 c) internal pure returns (uint8 hi, uint8 mid, uint8 lo) {
        // 3-element descending sort
        if (a >= b) {
            if (b >= c) {
                (hi, mid, lo) = (a, b, c);
            } else if (a >= c) {
                (hi, mid, lo) = (a, c, b);
            } else {
                (hi, mid, lo) = (c, a, b);
            }
        } else {
            if (a >= c) {
                (hi, mid, lo) = (b, a, c);
            } else if (b >= c) {
                (hi, mid, lo) = (b, c, a);
            } else {
                (hi, mid, lo) = (c, b, a);
            }
        }
    }

    /// @notice Returns 1 if player hand wins, -1 if dealer wins, 0 if tie
    function _compareHands(uint8 pClass, uint32 pTie, uint8 dClass, uint32 dTie) internal pure returns (int8) {
        if (pClass > dClass) return 1;
        if (pClass < dClass) return -1;
        if (pTie > dTie) return 1;
        if (pTie < dTie) return -1;
        return 0;
    }

    /// @notice Dealer qualifies on Q-high or better. Q-high = HIGH_CARD with top rank >= Q,
    /// or any hand class above HIGH_CARD
    function _dealerQualifies(uint8 dClass, uint8[3] memory dCards) internal pure returns (bool) {
        if (dClass > CLASS_HIGH_CARD) return true;
        // HIGH_CARD: check top rank
        uint8 r0 = uint8(dCards[0] % 13) + RANK_TWO;
        uint8 r1 = uint8(dCards[1] % 13) + RANK_TWO;
        uint8 r2 = uint8(dCards[2] % 13) + RANK_TWO;
        uint8 top = r0;
        if (r1 > top) top = r1;
        if (r2 > top) top = r2;
        return top >= QUALIFIER_RANK;
    }

    /* ========== PAYTABLE LOOKUPS ========== */

    function _anteBonusMultiplier(uint8 class_) internal pure returns (uint256) {
        if (class_ == CLASS_STRAIGHT_FLUSH) return ANTE_BONUS_STRAIGHT_FLUSH;
        if (class_ == CLASS_THREE_OF_A_KIND) return ANTE_BONUS_THREE_OF_A_KIND;
        if (class_ == CLASS_STRAIGHT) return ANTE_BONUS_STRAIGHT;
        return 0;
    }

    function _pairPlusMultiplier(uint8 class_) internal pure returns (uint256) {
        if (class_ == CLASS_STRAIGHT_FLUSH) return PAIR_PLUS_STRAIGHT_FLUSH;
        if (class_ == CLASS_THREE_OF_A_KIND) return PAIR_PLUS_THREE_OF_A_KIND;
        if (class_ == CLASS_STRAIGHT) return PAIR_PLUS_STRAIGHT;
        if (class_ == CLASS_FLUSH) return PAIR_PLUS_FLUSH;
        if (class_ == CLASS_PAIR) return PAIR_PLUS_PAIR;
        return 0;
    }

    /* ========== INTERNAL HELPERS ========== */

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
            uint256 pairPlusAmount,
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
            b.pairPlusAmount,
            b.totalPayout,
            b.placedAt,
            b.resolvedAt,
            b.status,
            b.outcome
        );
    }

    function getBetCards(
        uint256 betId
    ) external view override returns (uint8[3] memory playerCards, uint8[3] memory dealerCards) {
        Bet storage b = bets[betId];
        return (b.playerCards, b.dealerCards);
    }

    function getBetPayouts(
        uint256 betId
    )
        external
        view
        override
        returns (uint256 pairPlusPayout, uint256 anteBonusPayout, uint256 anteAndPlayPayout, uint256 totalPayout)
    {
        Bet storage b = bets[betId];
        return (b.pairPlusPayout, b.anteBonusPayout, b.anteAndPlayPayout, b.totalPayout);
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
