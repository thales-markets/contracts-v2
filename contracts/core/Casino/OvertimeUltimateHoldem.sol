// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoOvertimeUltimateHoldem.sol";

/// @title OvertimeUltimateHoldem
/// @author Overtime
/// @notice Ultimate Texas Hold'em vs the dealer. Player posts Ante + Blind (equal). Three decision
/// points:
///   1. Pre-flop (see hole only): raise 3× ante OR check
///   2. Post-flop (see flop): raise 2× ante OR check (only if checked pre-flop)
///   3. Post-river (see all community): raise 1× ante OR fold (only if checked through)
///
/// Each decision triggers a separate VRF request so future cards aren't in storage when the player
/// commits (otherwise `eth_getStorageAt` would let players see the river / dealer hole and exploit).
///
/// @dev All funds, randomness, free-bets, and circuit-breaker accounting live in `CasinoCoreV2`.
///
/// Locked paytables:
/// - Ante: pays 1:1 on player win, pushes on dealer not qualified, loses on dealer win
/// - Play: pays 1:1 on player win, loses on dealer win, pushes on tie/dealer-not-qualified
/// - Blind (paid only when player wins): Royal 500:1 / SF 50:1 / 4oK 10:1 / FH 3:1 / Flush 1:1 /
///   Straight 1:1; less than Straight pushes (Flush dropped from 3:2 → 1:1 for EoR margin).
///
/// House edge per ante ~5%, EoR ~1.4% (capped 3× pre-flop raise vs standard 4×).
contract OvertimeUltimateHoldem is
    ICasinoOvertimeUltimateHoldem,
    ICasinoGameCallback,
    Initializable,
    ProxyOwned,
    ProxyPausable,
    ProxyReentrancyGuard
{
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant DECK_SIZE = 52;

    uint8 private constant HOLE_CARDS = 2;
    uint8 private constant FLOP_CARDS = 3;

    /// @dev 16 bits per Fisher-Yates swap. Worst case: 7 swaps × 16 = 112 bits in a single VRF
    /// word (post-pre-flop-raise reveals flop + turn + river + dealer hole). Bias < 0.04%/swap.
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
    uint8 private constant RANK_ACE = 14;

    // Blind paytable (paid on top of stake when player wins). Below Straight = push (no bonus,
    // but stake returns — handled in resolution code by paying 1× the blind back as "stake-back").
    uint256 private constant BLIND_MULT_ROYAL = 500;
    uint256 private constant BLIND_MULT_STRAIGHT_FLUSH = 50;
    uint256 private constant BLIND_MULT_FOUR_OF_A_KIND = 10;
    uint256 private constant BLIND_MULT_FULL_HOUSE = 3;
    uint256 private constant BLIND_MULT_FLUSH = 1;
    uint256 private constant BLIND_MULT_STRAIGHT = 1;

    // Pre-flop raise multiplier (capped at 3× for EoR floor)
    uint256 private constant PRE_FLOP_RAISE_MULT = 3;
    uint256 private constant POST_FLOP_RAISE_MULT = 2;
    uint256 private constant RIVER_RAISE_MULT = 1;

    // Reservation: worst-case payout at placeBet time.
    //   Player raises 3× pre-flop and hits a Royal AND wins everything:
    //   - Ante side: ante stake-back + 1× win = 2 × ante
    //   - Blind side: blind stake-back + 500× = 501 × blind = 501 × ante (blind == ante)
    //   - Play side:  3 × ante stake-back + 3 × ante win = 6 × ante
    //   Total = 509 × ante
    uint256 private constant MAX_PAYOUT_ANTE_MULT = 509;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error AboveMaxBet();
    error BetNotFound();
    error BetNotOwner();
    error InvalidBetStatus();
    error CancelTimeoutNotReached();

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 anteAmount; // also = blindAmount (equal by rule)
        uint256 playAmount; // set when player raises (3×, 2×, or 1× ante); 0 if folded/no-raise
        uint256 totalPayout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reservation; // single combined reservation (worst-case payout)
        uint256 requestId;
        uint8[2] playerHole;
        uint8[5] community; // [flop0, flop1, flop2, turn, river]
        uint8[2] dealerHole;
        BetStatus status;
        Outcome outcome;
        uint256 antePayout;
        uint256 blindPayout;
        uint256 playPayout;
        // Bet placed with free-bet balance — Ante/Blind at place and raise(s) pulled from FBH.
        // All settlements route through FBH; referrer payments suppressed on loss
        bool isFreeBet;
        // Remaining net-profit budget for this bet in collateral units. Sized at placeBet from
        // `effectiveMaxProfitUsd × price`, capped against the worst-case uncapped profit.
        // Resolve truncates final payout to stakeOut + this. Appended at end for storage-safe
        // upgrade
        uint256 profitCapRemaining;
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

    /* ========== PLACE BET ========== */

    /// @notice Places a UTH bet. Pulls Ante + Blind (equal amounts) upfront, triggers VRF1 for
    /// the player's two hole cards
    function placeBet(
        address collateral,
        uint256 anteAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(msg.sender, collateral, anteAmount, referrer, false);
    }

    /// @notice Places a UTH bet using free-bet balance held in FreeBetsHolder. All subsequent
    /// raises also pull from FBH. If FBH runs short the user must fold (or check past the
    /// raise opportunity).
    function placeBetWithFreeBet(
        address collateral,
        uint256 anteAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        address freeBetsHolder = core.freeBetsHolder();
        if (msg.sender != freeBetsHolder) revert InvalidSender();
        // tx.origin convention used elsewhere in V2: FBH forwards calls; user identity = origin
        return _placeBet(tx.origin, collateral, anteAmount, referrer, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint256 anteAmount,
        address referrer,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        if (anteAmount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        _checkBetSize(collateral, anteAmount);
        uint256 cappedProfit = _cappedProfit(collateral, anteAmount);

        // Pull Ante + Blind from user / FBH
        uint256 stakeIn = anteAmount * 2;
        if (isFreeBet) {
            core.useFreeBet(user, collateral, stakeIn);
        } else {
            core.pullFromUser(user, collateral, stakeIn);
            if (referrer != address(0)) core.setReferrer(referrer, user);
        }

        // Reservation = stakes_pulled_so_far + capped net-profit budget. Raise paths top this
        // up with the raise amount (covers larger stake-back potential)
        uint256 reservation = stakeIn + cappedProfit;
        core.reserveOrRevert(collateral, reservation);

        requestId = core.requestRandomWords(1);
        betId = nextBetId++;

        Bet storage b = bets[betId];
        b.user = user;
        b.collateral = collateral;
        b.anteAmount = anteAmount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.status = BetStatus.AWAITING_DEAL;
        b.reservation = reservation;
        b.isFreeBet = isFreeBet;
        b.profitCapRemaining = cappedProfit;

        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        emit BetPlaced(betId, requestId, user, collateral, anteAmount);
    }

    /* ========== DECISION POINTS ========== */

    /// @notice Pre-flop raise (3× ante). Triggers VRF2 to reveal flop + turn + river + dealer hole
    /// in one shot — game is going to showdown
    function playPreFlop(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.PRE_FLOP_TURN);
        _pullPlayStake(b, PRE_FLOP_RAISE_MULT);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedPreFlop(betId, b.user, b.playAmount);
    }

    /// @notice Pre-flop check. Triggers VRF2 to reveal flop only; defer raise/check to post-flop
    function checkPreFlop(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.PRE_FLOP_TURN);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_FLOP);
        emit CheckedPreFlop(betId, requestId, b.user);
    }

    /// @notice Post-flop raise (2× ante). Triggers VRF3 to reveal turn + river + dealer hole
    function playPostFlop(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_FLOP_TURN);
        _pullPlayStake(b, POST_FLOP_RAISE_MULT);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedPostFlop(betId, b.user, b.playAmount);
    }

    /// @notice Post-flop check. Triggers VRF3 to reveal turn + river only; defer to river
    function checkPostFlop(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_FLOP_TURN);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_TURN_RIVER);
        emit CheckedPostFlop(betId, requestId, b.user);
    }

    /// @notice Post-river raise (1× ante). Final decision — triggers VRF4 to reveal dealer hole
    function playRiver(uint256 betId) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_RIVER_TURN);
        _pullPlayStake(b, RIVER_RAISE_MULT);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedRiver(betId, requestId, b.user, b.playAmount);
    }

    /// @notice Fold after seeing the river — player forfeits Ante AND Blind. Only available at
    /// POST_RIVER_TURN; folds earlier in the hand aren't a thing in UTH (player can check for free)
    function fold(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_RIVER_TURN);

        // Release the full reservation (game ends here — no payout)
        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        // Record loss: stake = ante + blind, payout = 0
        uint256 lostStake = b.anteAmount * 2;
        core.recordSettlement(b.collateral, lostStake, 0);
        if (!b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, lostStake);
        }

        b.status = BetStatus.RESOLVED;
        b.outcome = Outcome.FOLDED;
        b.resolvedAt = block.timestamp;
        emit Folded(betId, b.user);
    }

    /* ========== CANCEL ========== */

    /// @notice User-initiated cancel for a bet whose VRF callback has stalled longer than the
    /// `cancelTimeout`. Allowed only from AWAITING_* states (not PLAYER_TURN — those require an
    /// explicit fold/play/check)
    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (
            b.status != BetStatus.AWAITING_DEAL &&
            b.status != BetStatus.AWAITING_FLOP &&
            b.status != BetStatus.AWAITING_TURN_RIVER &&
            b.status != BetStatus.AWAITING_RESOLVE
        ) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    /// @notice Operator emergency cancel — bypasses timeout. Also accepts PLAYER_TURN states so
    /// the resolver can rescue a bet whose user has walked away mid-decision (matches blackjack
    /// `adminCancelHand`). Refunds the user; admin must avoid abuse
    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status == BetStatus.RESOLVED || b.status == BetStatus.CANCELLED) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];

        // Refund: ante + blind + whatever play stake was pulled. playAmount is 0 unless the
        // player has already committed a raise at some decision point
        uint256 refund = b.anteAmount * 2 + b.playAmount;

        // Release full reservation — no payout happens on cancel
        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        // Refund stakes — routes back to FBH if free-bet
        core.payOut(b.user, b.collateral, refund, b.isFreeBet, refund);

        b.totalPayout = refund;
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
        uint256 word = randomWords[0];
        if (b.status == BetStatus.AWAITING_DEAL) {
            _onPlayerHoleDealt(betId, b, word);
        } else if (b.status == BetStatus.AWAITING_FLOP) {
            _onFlopDealt(betId, b, word);
        } else if (b.status == BetStatus.AWAITING_TURN_RIVER) {
            _onTurnRiverDealt(betId, b, word);
        } else if (b.status == BetStatus.AWAITING_RESOLVE) {
            _onResolveFulfilled(betId, b, word);
        }
        // any other state: stale callback, ignore (mapping already cleared above)
    }

    function _onPlayerHoleDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[] memory deck = _initDeckMask(DECK_SIZE, 0);
        _partialFisherYates(deck, HOLE_CARDS, word);
        b.playerHole[0] = deck[0];
        b.playerHole[1] = deck[1];
        b.status = BetStatus.PRE_FLOP_TURN;
        emit PlayerHoleDealt(betId, b.requestId, b.user, deck[0], deck[1]);
    }

    function _onFlopDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint64 mask = _excludeMaskHole(b);
        uint8[] memory deck = _initDeckMask(DECK_SIZE - HOLE_CARDS, mask);
        _partialFisherYates(deck, FLOP_CARDS, word);
        b.community[0] = deck[0];
        b.community[1] = deck[1];
        b.community[2] = deck[2];
        b.status = BetStatus.POST_FLOP_TURN;
        emit FlopDealt(betId, b.requestId, b.user, deck[0], deck[1], deck[2]);
    }

    function _onTurnRiverDealt(uint256 betId, Bet storage b, uint256 word) internal {
        // Exclude: 2 player hole + 3 flop cards
        uint64 mask = _excludeMaskHole(b) |
            (uint64(1) << b.community[0]) |
            (uint64(1) << b.community[1]) |
            (uint64(1) << b.community[2]);
        uint8[] memory deck = _initDeckMask(DECK_SIZE - 5, mask);
        _partialFisherYates(deck, 2, word);
        b.community[3] = deck[0];
        b.community[4] = deck[1];
        b.status = BetStatus.POST_RIVER_TURN;
        emit TurnRiverDealt(betId, b.requestId, b.user, deck[0], deck[1]);
    }

    /// @notice Final VRF — deal whatever community cards remain plus dealer hole, then resolve.
    /// Routes by `playAmount` (the raise multiplier identifies the path)
    function _onResolveFulfilled(uint256 betId, Bet storage b, uint256 word) internal {
        // playAmount is 3×, 2×, or 1× ante depending on which raise put us in AWAITING_RESOLVE.
        // It uniquely identifies how many cards still need dealing.
        uint256 playMult = b.playAmount / b.anteAmount;
        uint64 mask = _excludeMaskHole(b);
        if (playMult == PRE_FLOP_RAISE_MULT) {
            // Pre-flop raise path: no community dealt → 5 community + 2 dealer = 7 cards
            _dealRemaining(b, mask, word, 7, 0, 5);
        } else if (playMult == POST_FLOP_RAISE_MULT) {
            // Post-flop raise path: flop dealt → 2 community + 2 dealer = 4 cards
            mask |= (uint64(1) << b.community[0]) | (uint64(1) << b.community[1]) | (uint64(1) << b.community[2]);
            _dealRemaining(b, mask, word, 4, 3, 2);
        } else {
            // River raise path (playMult == 1): all community dealt → 2 dealer cards only
            for (uint8 i; i < 5; ++i) {
                mask |= uint64(1) << b.community[i];
            }
            _dealRemaining(b, mask, word, 2, 5, 0);
        }

        // Resolve
        Resolution memory r = _computeResolution(b);
        uint256 totalPayout = r.antePayout + r.blindPayout + r.playPayout;
        uint256 stakeOut = b.anteAmount * 2 + b.playAmount;

        // Soft-cap net profit. Truncate the variance-heavy Blind side first (Royal 500x lives here)
        if (totalPayout > stakeOut) {
            uint256 profit = totalPayout - stakeOut;
            if (profit > b.profitCapRemaining) {
                uint256 cut = profit - b.profitCapRemaining;
                if (r.blindPayout >= cut) {
                    r.blindPayout -= cut;
                } else {
                    cut -= r.blindPayout;
                    r.blindPayout = 0;
                    // Spill remaining cut into ante/play (rare; would only happen if cap is tiny)
                    if (r.antePayout >= cut) r.antePayout -= cut;
                    else {
                        cut -= r.antePayout;
                        r.antePayout = 0;
                        r.playPayout -= cut;
                    }
                }
                profit = b.profitCapRemaining;
            }
            totalPayout = stakeOut + profit;
            b.profitCapRemaining -= profit;
        }

        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        if (totalPayout > 0) {
            core.payOut(b.user, b.collateral, totalPayout, b.isFreeBet, stakeOut);
        }
        core.recordSettlement(b.collateral, stakeOut, totalPayout);

        if (totalPayout < stakeOut && !b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, stakeOut - totalPayout);
        }

        b.outcome = r.outcome;
        b.antePayout = r.antePayout;
        b.blindPayout = r.blindPayout;
        b.playPayout = r.playPayout;
        b.totalPayout = totalPayout;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(
            betId,
            b.requestId,
            b.user,
            r.outcome,
            b.dealerHole[0],
            b.dealerHole[1],
            r.antePayout,
            r.blindPayout,
            r.playPayout,
            totalPayout
        );
    }

    /// @dev Deal `nCards` from the mask-excluded deck, splitting into `communityCount` community
    /// slots starting at `startCommunityIdx`, then 2 dealer hole cards
    function _dealRemaining(
        Bet storage b,
        uint64 mask,
        uint256 word,
        uint8 nCards,
        uint8 startCommunityIdx,
        uint8 communityCount
    ) internal {
        // popcount(mask) = DECK_SIZE - deckSize
        uint8 deckSize = DECK_SIZE - _popcount(mask);
        uint8[] memory deck = _initDeckMask(deckSize, mask);
        _partialFisherYates(deck, nCards, word);
        for (uint8 i; i < communityCount; ++i) {
            b.community[startCommunityIdx + i] = deck[i];
        }
        b.dealerHole[0] = deck[communityCount];
        b.dealerHole[1] = deck[communityCount + 1];
    }

    /* ========== RESOLUTION ========== */

    /// @notice Resolution result. Memory-only struct extracted to avoid stack-too-deep
    struct Resolution {
        Outcome outcome;
        uint256 antePayout; // total returned (stake + win) for Ante leg
        uint256 blindPayout; // total returned for Blind leg
        uint256 playPayout; // total returned for Play leg
    }

    function _computeResolution(Bet storage b) internal view returns (Resolution memory r) {
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

        bool dealerQualifies = _dealerQualifies(dVal);

        if (!dealerQualifies) {
            // Ante pushes (returns stake). Play and Blind pay normally based on player hand
            r.outcome = Outcome.DEALER_NOT_QUALIFIED;
            r.antePayout = b.anteAmount; // push
            r.playPayout = _playWinPayout(b);
            r.blindPayout = _blindWinPayout(b, pVal);
            return r;
        }

        if (pVal > dVal) {
            r.outcome = Outcome.PLAYER_WIN;
            r.antePayout = b.anteAmount * 2; // 1:1 + stake back
            r.playPayout = _playWinPayout(b);
            r.blindPayout = _blindWinPayout(b, pVal);
        } else if (pVal < dVal) {
            r.outcome = Outcome.DEALER_WIN;
            // All three legs lose (paid 0)
        } else {
            r.outcome = Outcome.TIE;
            r.antePayout = b.anteAmount; // push
            r.playPayout = b.playAmount; // push
            r.blindPayout = b.anteAmount; // push (Blind = ante amount)
        }
    }

    /// @notice Play leg pays 1:1 (stake + win) when player wins or dealer doesn't qualify
    function _playWinPayout(Bet storage b) internal view returns (uint256) {
        if (b.playAmount == 0) return 0;
        return b.playAmount * 2;
    }

    /// @notice Blind leg pays per paytable when player wins. Premium hands get a bonus on top of
    /// the stake; non-premium hands push (return stake only)
    function _blindWinPayout(Bet storage b, uint256 handValue) internal view returns (uint256) {
        uint256 mult = _blindPaytableMultiplier(handValue);
        if (mult == 0) {
            // Non-premium hand → push (return stake only, no bonus)
            return b.anteAmount;
        }
        // Stake + (mult × stake) — Blind size == ante size
        return b.anteAmount * (1 + mult);
    }

    function _blindPaytableMultiplier(uint256 handValue) internal pure returns (uint256) {
        uint8 class_ = uint8(handValue >> 20);
        if (class_ == CLASS_ROYAL_FLUSH) return BLIND_MULT_ROYAL;
        if (class_ == CLASS_STRAIGHT_FLUSH) return BLIND_MULT_STRAIGHT_FLUSH;
        if (class_ == CLASS_FOUR_OF_A_KIND) return BLIND_MULT_FOUR_OF_A_KIND;
        if (class_ == CLASS_FULL_HOUSE) return BLIND_MULT_FULL_HOUSE;
        if (class_ == CLASS_FLUSH) return BLIND_MULT_FLUSH;
        if (class_ == CLASS_STRAIGHT) return BLIND_MULT_STRAIGHT;
        return 0; // below Straight → push
    }

    function _dealerQualifies(uint256 handValue) internal pure returns (bool) {
        // UTH dealer needs Pair or better
        uint8 class_ = uint8(handValue >> 20);
        return class_ >= CLASS_PAIR;
    }

    /* ========== INTERNAL: STAKES + VRF ========== */

    function _pullPlayStake(Bet storage b, uint256 mult) internal {
        uint256 playStake = b.anteAmount * mult;
        b.playAmount = playStake;
        if (b.isFreeBet) {
            core.useFreeBet(b.user, b.collateral, playStake);
        } else {
            core.pullFromUser(b.user, b.collateral, playStake);
        }
        // Extend reservation by the raise (covers the larger stake-back potential at resolve).
        // Profit-side cap was reserved at placeBet and is unchanged
        core.reserveOrRevert(b.collateral, playStake);
        b.reservation += playStake;
    }

    function _checkBetSize(address collateral, uint256 anteAmount) internal view {
        uint256 anteUsd = core.getUsdValue(collateral, anteAmount);
        uint256 minBet = core.effectiveMinBetUsd(address(this));
        if (minBet == 0) minBet = MIN_BET_USD;
        if (anteUsd < minBet) revert InvalidAmount();
        uint256 maxBet = core.effectiveMaxBetUsd(address(this));
        if (maxBet != 0 && anteUsd > maxBet) revert AboveMaxBet();
    }

    /// @notice Worst-case net profit for this bet truncated by the per-game USD profit cap,
    /// returned in collateral units. Uncapped worst = (MAX_PAYOUT_ANTE_MULT - 5) × ante = 504×.
    /// Resolve truncates final payout to stakeOut + `b.profitCapRemaining`
    function _cappedProfit(address collateral, uint256 anteAmount) internal view returns (uint256) {
        uint256 worst = anteAmount * (MAX_PAYOUT_ANTE_MULT - 5);
        uint256 capCollateral = core.collateralFromUsd(collateral, core.effectiveMaxProfitUsd(address(this)));
        return worst > capCollateral ? capCollateral : worst;
    }

    function _requestVrfAndAdvance(uint256 betId, Bet storage b, BetStatus newStatus) internal returns (uint256 requestId) {
        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = newStatus;
        requestIdToBetId[requestId] = betId;
    }

    /* ========== HAND EVALUATION (5 or 7 cards) ========== */

    /// @notice Evaluates a hand of 5–7 cards and returns the packed best-5 hand value.
    /// Encoding: [class:4][r1:4][r2:4][r3:4][r4:4][r5:4]. Higher = better.
    /// `class` = 0 (HC) .. 9 (Royal). Padded ranks default to 0
    function _evaluateCards(uint8[] memory cards) internal pure returns (uint256) {
        uint8[15] memory rankCount;
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

        int8 flushSuit = -1;
        for (uint8 s; s < 4; ++s) {
            if (suitCount[s] >= 5) {
                flushSuit = int8(s);
                break;
            }
        }

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

        uint8 fourRank;
        uint8 firstThree;
        uint8 secondThree;
        uint8 firstPair;
        uint8 secondPair;
        for (uint8 step; step < 13; ++step) {
            uint8 r = RANK_ACE - step;
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

        if (fourRank > 0) {
            uint8 kicker = _topNRanksExcluding(rankMask, 1, fourRank, 0, 0)[0];
            return _pack(CLASS_FOUR_OF_A_KIND, fourRank, kicker, 0, 0, 0);
        }

        if (firstThree > 0 && (secondThree > 0 || firstPair > 0)) {
            uint8 pairRank = secondThree > firstPair ? secondThree : firstPair;
            return _pack(CLASS_FULL_HOUSE, firstThree, pairRank, 0, 0, 0);
        }

        if (flushSuit >= 0) {
            uint8[5] memory top5 = _topNRanks(suitRankMask[uint8(flushSuit)], 5);
            return _pack(CLASS_FLUSH, top5[0], top5[1], top5[2], top5[3], top5[4]);
        }

        uint8 straightTop = _findStraightTop(rankMask);
        if (straightTop > 0) {
            return _pack(CLASS_STRAIGHT, straightTop, 0, 0, 0, 0);
        }

        if (firstThree > 0) {
            uint8[5] memory kickers = _topNRanksExcluding(rankMask, 2, firstThree, 0, 0);
            return _pack(CLASS_THREE_OF_A_KIND, firstThree, kickers[0], kickers[1], 0, 0);
        }

        if (firstPair > 0 && secondPair > 0) {
            uint8[5] memory kickers = _topNRanksExcluding(rankMask, 1, firstPair, secondPair, 0);
            return _pack(CLASS_TWO_PAIR, firstPair, secondPair, kickers[0], 0, 0);
        }

        if (firstPair > 0) {
            uint8[5] memory kickers = _topNRanksExcluding(rankMask, 3, firstPair, 0, 0);
            return _pack(CLASS_PAIR, firstPair, kickers[0], kickers[1], kickers[2], 0);
        }

        uint8[5] memory hc = _topNRanks(rankMask, 5);
        return _pack(CLASS_HIGH_CARD, hc[0], hc[1], hc[2], hc[3], hc[4]);
    }

    function _findStraightTop(uint16 mask) internal pure returns (uint8) {
        for (uint8 step; step <= 8; ++step) {
            uint8 top = RANK_ACE - step;
            uint16 fiveMask = uint16(0x1F) << (top - 4);
            if ((mask & fiveMask) == fiveMask) {
                return top;
            }
        }
        // Wheel: A-2-3-4-5 → top = 5
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

    /* ========== DECK / SHUFFLE ========== */

    function _initDeckMask(uint8 size, uint64 excludeMask) internal pure returns (uint8[] memory deck) {
        deck = new uint8[](size);
        uint8 j;
        for (uint8 c; c < DECK_SIZE; ++c) {
            if (excludeMask != 0 && (excludeMask & (uint64(1) << c)) != 0) continue;
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

    function _excludeMaskHole(Bet storage b) internal view returns (uint64) {
        return (uint64(1) << b.playerHole[0]) | (uint64(1) << b.playerHole[1]);
    }

    function _popcount(uint64 x) internal pure returns (uint8 c) {
        unchecked {
            while (x != 0) {
                c += uint8(x & 1);
                x >>= 1;
            }
        }
    }

    /* ========== INTERNAL HELPERS ========== */

    function _toMemArray7(uint8[7] memory src) internal pure returns (uint8[] memory out) {
        out = new uint8[](7);
        for (uint8 i; i < 7; ++i) out[i] = src[i];
    }

    function _requireOwnedAt(Bet storage b, BetStatus expected) internal view {
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != expected) revert InvalidBetStatus();
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
            uint256 playAmount,
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
            b.playAmount,
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
    ) external view override returns (uint256 antePayout, uint256 blindPayout, uint256 playPayout, uint256 totalPayout) {
        Bet storage b = bets[betId];
        return (b.antePayout, b.blindPayout, b.playPayout, b.totalPayout);
    }

    function getFullRecord(uint256 betId) external view override returns (FullRecord memory r) {
        Bet storage b = bets[betId];
        r.betId = betId;
        r.user = b.user;
        r.collateral = b.collateral;
        r.anteAmount = b.anteAmount;
        r.playAmount = b.playAmount;
        r.totalPayout = b.totalPayout;
        r.antePayout = b.antePayout;
        r.blindPayout = b.blindPayout;
        r.playPayout = b.playPayout;
        r.placedAt = b.placedAt;
        r.resolvedAt = b.resolvedAt;
        r.status = b.status;
        r.outcome = b.outcome;
        r.playerHole = b.playerHole;
        r.community = b.community;
        r.dealerHole = b.dealerHole;
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
