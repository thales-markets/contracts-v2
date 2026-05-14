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
import "./CasinoHandsLib.sol";

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
/// Locked paytables (Vegas / Shuffle Master standard rules):
/// - Ante: pays 1:1 on player win, pushes on dealer not qualified, loses on dealer win
/// - Play: resolves on hand comparison regardless of dealer qualification — 1:1 on player win,
///   push on tie, loses on dealer win
/// - Blind (only when player wins, otherwise pushes on tie / loses on dealer win): Royal 500:1 /
///   SF 50:1 / 4oK 10:1 / FH 3:1 / Flush 1:1 / Straight 1:1; less than Straight pushes (Flush
///   dropped from 3:2 → 1:1 for EoR margin).
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

    // Hand classes (higher numerical value beats lower). Mirror of `CasinoHandsLib.CLASS_*` for
    // local `_blindPaytableMultiplier` / `_dealerQualifies` readability — duplicated rather than
    // imported because constants aren't usable cross-contract via `using` and the lib values
    // are private to its evaluator
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
        return _placeBet(msg.sender, collateral, anteAmount, referrer, true);
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
        }
        if (referrer != address(0)) core.setReferrer(referrer, user);

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
    function playPreFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.PRE_FLOP_TURN);
        _pullPlayStake(b, PRE_FLOP_RAISE_MULT);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedPreFlop(betId, b.user, b.playAmount);
    }

    /// @notice Pre-flop check. Triggers VRF2 to reveal flop only; defer raise/check to post-flop
    function checkPreFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.PRE_FLOP_TURN);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_FLOP);
        emit CheckedPreFlop(betId, requestId, b.user);
    }

    /// @notice Post-flop raise (2× ante). Triggers VRF3 to reveal turn + river + dealer hole
    function playPostFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_FLOP_TURN);
        _pullPlayStake(b, POST_FLOP_RAISE_MULT);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedPostFlop(betId, b.user, b.playAmount);
    }

    /// @notice Post-flop check. Triggers VRF3 to reveal turn + river only; defer to river
    function checkPostFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_FLOP_TURN);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_TURN_RIVER);
        emit CheckedPostFlop(betId, requestId, b.user);
    }

    /// @notice Post-river raise (1× ante). Final decision — triggers VRF4 to reveal dealer hole
    function playRiver(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.POST_RIVER_TURN);
        _pullPlayStake(b, RIVER_RAISE_MULT);
        requestId = _requestVrfAndAdvance(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedRiver(betId, requestId, b.user, b.playAmount);
    }

    /// @notice Fold after seeing the river — player forfeits Ante AND Blind. Only available at
    /// POST_RIVER_TURN; folds earlier in the hand aren't a thing in UTH (player can check for free)
    function fold(uint256 betId) external override nonReentrant notPaused {
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
        // Clear any in-flight VRF mapping so a late callback's mapping lookup is a no-op
        // (status-check would also catch it, but matches the hygiene pattern of the other 4 games)
        if (b.requestId != 0) delete requestIdToBetId[b.requestId];

        // Refund: ante + blind + whatever play stake was pulled. playAmount is 0 unless the
        // player has already committed a raise at some decision point
        uint256 refund = b.anteAmount * 2 + b.playAmount;

        // Release full reservation — no payout happens on cancel
        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        // Refund stakes — routes back to FBH if free-bet
        core.payOut(b.user, b.collateral, refund, b.isFreeBet, refund);

        // Decrement core's pending-stake counter (stake == refund → zero P&L impact)
        core.recordSettlement(b.collateral, refund, refund);

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
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE, 0);
        CasinoHandsLib.partialFisherYates(deck, HOLE_CARDS, word);
        b.playerHole[0] = deck[0];
        b.playerHole[1] = deck[1];
        b.status = BetStatus.PRE_FLOP_TURN;
        emit PlayerHoleDealt(betId, b.requestId, b.user, deck[0], deck[1]);
    }

    function _onFlopDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint64 mask = _excludeMaskHole(b);
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE - HOLE_CARDS, mask);
        CasinoHandsLib.partialFisherYates(deck, FLOP_CARDS, word);
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
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE - 5, mask);
        CasinoHandsLib.partialFisherYates(deck, 2, word);
        b.community[3] = deck[0];
        b.community[4] = deck[1];
        b.status = BetStatus.POST_RIVER_TURN;
        emit TurnRiverDealt(betId, b.requestId, b.user, deck[0], deck[1]);
    }

    /// @notice Final VRF — deal whatever community cards remain plus dealer hole, then resolve.
    /// Routes by `playAmount` (the raise multiplier identifies the path)
    function _onResolveFulfilled(uint256 betId, Bet storage b, uint256 word) internal {
        // Defensive: every path that sets status=AWAITING_RESOLVE first calls _pullPlayStake,
        // which sets playAmount = ante * mult. A zero playAmount here means a future regression
        // bypassed that — without this guard, playMult would be 0 and silently misroute to the
        // river-raise branch with stale community cards, producing a wrong-hand payout. Revert
        // instead; the bet stays in AWAITING_RESOLVE and is recoverable via adminCancelBet
        if (b.playAmount == 0) revert InvalidBetStatus();

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
        } else if (playMult == RIVER_RAISE_MULT) {
            // River raise path: all community dealt → 2 dealer cards only
            for (uint8 i; i < 5; ++i) {
                mask |= uint64(1) << b.community[i];
            }
            _dealRemaining(b, mask, word, 2, 5, 0);
        } else {
            // Defensive: only PRE_FLOP / POST_FLOP / RIVER raise paths can reach AWAITING_RESOLVE.
            // Any other playMult means a future regression introduced a new raise multiplier
            // without updating this dispatch — revert rather than misroute the deal
            revert InvalidBetStatus();
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
                    // Spill remaining cut into ante/play (rare; would only happen if cap is tiny).
                    // Symmetric guards across all 3 legs defend against future paytable changes
                    // that could rebalance the worst-case math and otherwise underflow this branch
                    if (r.antePayout >= cut) r.antePayout -= cut;
                    else {
                        cut -= r.antePayout;
                        r.antePayout = 0;
                        if (r.playPayout >= cut) r.playPayout -= cut;
                        else r.playPayout = 0;
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
        uint8 deckSize = DECK_SIZE - CasinoHandsLib.popcount(mask);
        uint8[] memory deck = CasinoHandsLib.initDeck(deckSize, mask);
        CasinoHandsLib.partialFisherYates(deck, nCards, word);
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

        uint256 pVal = CasinoHandsLib.evaluateCards7(CasinoHandsLib.toMemArray7(pSeven));
        uint256 dVal = CasinoHandsLib.evaluateCards7(CasinoHandsLib.toMemArray7(dSeven));

        bool dealerQualifies = _dealerQualifies(dVal);

        // Vegas / Shuffle Master standard: dealer-qualification only protects the Ante. Play and
        // Blind always resolve on player-vs-dealer hand comparison. When dealer doesn't qualify,
        // Ante pushes regardless of who has the better hand
        if (!dealerQualifies) {
            r.outcome = Outcome.DEALER_NOT_QUALIFIED;
            r.antePayout = b.anteAmount; // push (the qualifies rule's player benefit)
            if (pVal > dVal) {
                r.playPayout = _playWinPayout(b);
                r.blindPayout = _blindWinPayout(b, pVal);
            } else if (pVal == dVal) {
                r.playPayout = b.playAmount; // push
                r.blindPayout = b.anteAmount; // push
            }
            // pVal < dVal: play and blind both lose (paid 0)
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

    /// @dev Free-bet raises pull additional stake from FBH (not the user's wallet). If the
    /// user's FBH balance is exhausted, every raise tx reverts and the user can only
    /// check/fold from that point (or wait out `cancelTimeout`). FE must gate raise buttons
    /// on remaining FBH balance for free-bet hands — there is no wallet-funded raise path
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

    /* ========== INTERNAL HELPERS ========== */

    /// @notice Deck construction, Fisher-Yates shuffle, 7-card hand evaluator, top-N rank
    /// helpers, popcount, and value packing all live in `CasinoHandsLib` (internal pure,
    /// inlined at compile time — no DELEGATECALL, no separate deployment, no storage)

    function _excludeMaskHole(Bet storage b) internal view returns (uint64) {
        return (uint64(1) << b.playerHole[0]) | (uint64(1) << b.playerHole[1]);
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
