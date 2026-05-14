// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoVideoPoker.sol";
import "./CasinoHandsLib.sol";

/// @title VideoPoker
/// @author Overtime
/// @notice Jacks-or-Better Video Poker, "for 1" paytable with FH=8 / Flush=5 / Royal=500,
/// single-coin only. Two-VRF flow:
///   1. placeBet — pulls ante, VRF1 deals 5 cards, status → PLAYER_TURN
///   2. draw(holdMask) — VRF2 deals replacement cards for non-held slots, evaluates, resolves
///
/// Reservation: 500 × stake (Royal Flush = 500-for-1 max payout). RTP under optimal play ≈
/// 96.5% / house edge ≈ 3.5%, between standard 1-coin (Royal=250, 96.15%) and 5-coin
/// (Royal=800, 97.30%) variants. See `_paytableMultiplier` for the locked paytable. Pair-of-
/// Jacks rule is enforced in the multiplier lookup, NOT in the evaluator — the evaluator
/// returns CLASS_PAIR for any pair and the multiplier discriminates by rank
contract VideoPoker is
    ICasinoVideoPoker,
    ICasinoGameCallback,
    Initializable,
    ProxyOwned,
    ProxyPausable,
    ProxyReentrancyGuard
{
    /* ========== CONSTANTS ========== */

    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant DECK_SIZE = 52;
    uint8 private constant HAND_SIZE = 5;
    uint8 private constant HOLD_MASK_MAX = 31; // low 5 bits set

    // Hand classes (numerical match with OvertimeHoldem encoding)
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
    uint8 private constant RANK_JACK = 11;
    uint8 private constant RANK_ACE = 14;

    // 8/5 Jacks-or-Better paytable (multipliers on stake; lose otherwise)
    uint256 private constant MULT_ROYAL_FLUSH = 500;
    uint256 private constant MULT_STRAIGHT_FLUSH = 50;
    uint256 private constant MULT_FOUR_OF_A_KIND = 25;
    uint256 private constant MULT_FULL_HOUSE = 8;
    uint256 private constant MULT_FLUSH = 5;
    uint256 private constant MULT_STRAIGHT = 4;
    uint256 private constant MULT_THREE_OF_A_KIND = 3;
    uint256 private constant MULT_TWO_PAIR = 2;
    uint256 private constant MULT_JACKS_OR_BETTER = 1;

    /// @notice Largest paytable multiplier ("for 1" semantics — totalReturn = stake × mult on win,
    /// 0 on loss, stake-back on JoB push at mult=1). Worst-case payout is `stake × 500` (Royal),
    /// so worst-case net profit reservation is `stake × (MAX_PAYOUT_MULT - 1) = 499 × stake`
    uint256 private constant MAX_PAYOUT_MULT = 500;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidHoldMask();
    error AboveMaxBet();
    error BetNotFound();
    error BetNotOwner();
    error InvalidBetStatus();
    error CancelTimeoutNotReached();

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reservation;
        uint256 requestId;
        uint8[5] initialCards; // dealt at VRF1 (HAND_SIZE = 5)
        uint8[5] finalCards; // post-draw final 5 cards (== initialCards if all held)
        BetStatus status;
        HandClass handClass;
        uint8 holdMask; // low 5 bits, set on draw()
        uint256 multiplier;
        // Stake was pulled from FreeBetsHolder via core.useFreeBet instead of core.pullFromUser.
        // Routes payouts back to FBH on resolve / cancel and skips referrer payment on losses
        bool isFreeBet;
        // Remaining net-profit budget for this bet in collateral units. Sized at placeBet from
        // `effectiveMaxProfitUsd × price`. Resolve truncates final payout to stake + this.
        // Appended at end of struct for storage-safe upgrade
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

    /* ========== PLACE / DRAW / CANCEL ========== */

    function placeBet(
        address collateral,
        uint256 amount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(msg.sender, collateral, amount, referrer, false);
    }

    function placeBetWithFreeBet(
        address collateral,
        uint256 amount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(msg.sender, collateral, amount, referrer, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint256 amount,
        address referrer,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        _checkBetSize(collateral, amount);
        uint256 cappedProfit = _cappedProfit(collateral, amount);

        if (isFreeBet) {
            core.useFreeBet(user, collateral, amount);
        } else {
            core.pullFromUser(user, collateral, amount);
        }
        if (referrer != address(0)) core.setReferrer(referrer, user);

        // Reservation = stake + cappedProfit (worst-case capped payout)
        uint256 reservation = amount + cappedProfit;
        core.reserveOrRevert(collateral, reservation);

        requestId = core.requestRandomWords(1);
        betId = nextBetId++;

        Bet storage b = bets[betId];
        b.user = user;
        b.collateral = collateral;
        b.amount = amount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.reservation = reservation;
        b.status = BetStatus.AWAITING_DEAL;
        b.isFreeBet = isFreeBet;
        b.profitCapRemaining = cappedProfit;

        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        emit BetPlaced(betId, requestId, user, collateral, amount);
    }

    function draw(uint256 betId, uint8 holdMask) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();
        if (holdMask > HOLD_MASK_MAX) revert InvalidHoldMask();

        b.holdMask = holdMask;
        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = BetStatus.AWAITING_DRAW;
        requestIdToBetId[requestId] = betId;

        emit DrawRequested(betId, requestId, b.user, holdMask);
    }

    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.AWAITING_DEAL && b.status != BetStatus.AWAITING_DRAW) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status == BetStatus.RESOLVED || b.status == BetStatus.CANCELLED) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];
        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;
        core.payOut(b.user, b.collateral, b.amount, b.isFreeBet, b.amount);
        // Decrement core's pending-stake counter (stake == refund → zero P&L impact)
        core.recordSettlement(b.collateral, b.amount, b.amount);
        b.payout = b.amount;
        b.status = BetStatus.CANCELLED;
        b.resolvedAt = block.timestamp;
        if (b.requestId != 0) delete requestIdToBetId[b.requestId];
        emit BetCancelled(betId, b.user, b.amount, adminCancelled);
    }

    /* ========== VRF CALLBACK ========== */

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
            _onInitialDealt(betId, b, word);
        } else if (b.status == BetStatus.AWAITING_DRAW) {
            _onDrawDealt(betId, b, word);
        }
        // any other state: stale callback, ignore
    }

    function _onInitialDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE, 0);
        CasinoHandsLib.partialFisherYates(deck, HAND_SIZE, word);
        for (uint8 i; i < HAND_SIZE; ++i) {
            b.initialCards[i] = deck[i];
        }
        b.status = BetStatus.PLAYER_TURN;
        emit InitialDealRevealed(betId, b.requestId, b.user, deck[0], deck[1], deck[2], deck[3], deck[4]);
    }

    function _onDrawDealt(uint256 betId, Bet storage b, uint256 word) internal {
        // Build the final 5-card hand: held cards stay in place, others come from the remaining
        // 47-card deck via partial Fisher-Yates
        uint8 holdMask = b.holdMask;
        uint8 needed = HAND_SIZE - CasinoHandsLib.popcount(holdMask);

        uint64 excludeMask;
        for (uint8 i; i < HAND_SIZE; ++i) {
            excludeMask |= uint64(1) << b.initialCards[i];
        }

        uint8 deckSize = DECK_SIZE - HAND_SIZE; // 47
        uint8[] memory deck = CasinoHandsLib.initDeck(deckSize, excludeMask);
        if (needed > 0) {
            CasinoHandsLib.partialFisherYates(deck, needed, word);
        }

        uint8 deckCursor;
        for (uint8 i; i < HAND_SIZE; ++i) {
            if ((holdMask >> i) & 1 == 1) {
                b.finalCards[i] = b.initialCards[i];
            } else {
                b.finalCards[i] = deck[deckCursor];
                ++deckCursor;
            }
        }

        _resolve(betId, b);
    }

    /* ========== RESOLUTION ========== */

    function _resolve(uint256 betId, Bet storage b) internal {
        (uint8 class_, uint8 primaryRank) = _evaluateFive(b.finalCards);
        uint256 mult = _paytableMultiplier(class_, primaryRank);
        // "For 1" semantics: mult is the total-return multiplier on stake.
        //   JoB pair (mult=1) → totalReturn = stake (push, no profit)
        //   Two Pair (mult=2) → totalReturn = 2×stake (1× net profit)
        //   Royal (mult=500) → totalReturn = 500×stake (499× net profit)
        //   Loss (mult=0) → totalReturn = 0 (stake forfeit)
        uint256 totalReturn = b.amount * mult;

        // Soft-cap net profit against the per-bet budget
        if (totalReturn > b.amount) {
            uint256 profit = totalReturn - b.amount;
            if (profit > b.profitCapRemaining) profit = b.profitCapRemaining;
            totalReturn = b.amount + profit;
            b.profitCapRemaining -= profit;
        }

        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        if (totalReturn > 0) {
            core.payOut(b.user, b.collateral, totalReturn, b.isFreeBet, b.amount);
        }
        core.recordSettlement(b.collateral, b.amount, totalReturn);

        // Skip referrer payment on free bets — user lost no real funds, so no referral fee
        if (totalReturn < b.amount && !b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, b.amount - totalReturn);
        }

        b.handClass = HandClass(class_);
        b.multiplier = mult;
        b.payout = totalReturn;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(
            betId,
            b.requestId,
            b.user,
            b.finalCards[0],
            b.finalCards[1],
            b.finalCards[2],
            b.finalCards[3],
            b.finalCards[4],
            HandClass(class_),
            mult,
            totalReturn
        );
    }

    /// @notice Paytable lookup. `primaryRank` is the rank of the pair (for CLASS_PAIR only) —
    /// used to apply the Jacks-or-Better cut-off. For other classes it's ignored
    function _paytableMultiplier(uint8 class_, uint8 primaryRank) internal pure returns (uint256) {
        if (class_ == CLASS_ROYAL_FLUSH) return MULT_ROYAL_FLUSH;
        if (class_ == CLASS_STRAIGHT_FLUSH) return MULT_STRAIGHT_FLUSH;
        if (class_ == CLASS_FOUR_OF_A_KIND) return MULT_FOUR_OF_A_KIND;
        if (class_ == CLASS_FULL_HOUSE) return MULT_FULL_HOUSE;
        if (class_ == CLASS_FLUSH) return MULT_FLUSH;
        if (class_ == CLASS_STRAIGHT) return MULT_STRAIGHT;
        if (class_ == CLASS_THREE_OF_A_KIND) return MULT_THREE_OF_A_KIND;
        if (class_ == CLASS_TWO_PAIR) return MULT_TWO_PAIR;
        if (class_ == CLASS_PAIR && primaryRank >= RANK_JACK) return MULT_JACKS_OR_BETTER;
        return 0;
    }

    /* ========== HAND EVALUATION (5-card only) ========== */

    /// @notice Evaluates a 5-card hand. Returns `(class_, primaryRank)` where `primaryRank` is
    /// the rank of the pair when class_ == PAIR (used for the Jacks-or-Better cut-off). For
    /// other classes the returned `primaryRank` is the highest meaningful rank in the hand
    function _evaluateFive(uint8[5] storage cards) internal view returns (uint8 class_, uint8 primaryRank) {
        uint8[15] memory rankCount;
        uint16 rankMask;
        bool flush = true;
        uint8 suit0 = cards[0] / 13;

        for (uint8 i; i < HAND_SIZE; ++i) {
            uint8 r = (cards[i] % 13) + RANK_TWO;
            ++rankCount[r];
            rankMask |= uint16(1) << r;
            if (cards[i] / 13 != suit0) flush = false;
        }

        uint8 straightTop = CasinoHandsLib.findStraightTop(rankMask);

        if (flush && straightTop > 0) {
            if (straightTop == RANK_ACE) {
                return (CLASS_ROYAL_FLUSH, RANK_ACE);
            }
            return (CLASS_STRAIGHT_FLUSH, straightTop);
        }

        // Scan ranks high → low for pairs / trips / quads
        uint8 fourRank;
        uint8 threeRank;
        uint8 firstPair;
        uint8 secondPair;
        for (uint8 step; step < 13; ++step) {
            uint8 r = RANK_ACE - step;
            uint8 c = rankCount[r];
            if (c == 4) {
                fourRank = r;
            } else if (c == 3) {
                threeRank = r;
            } else if (c == 2) {
                if (firstPair == 0) firstPair = r;
                else if (secondPair == 0) secondPair = r;
            }
        }

        if (fourRank > 0) {
            return (CLASS_FOUR_OF_A_KIND, fourRank);
        }
        if (threeRank > 0 && firstPair > 0) {
            return (CLASS_FULL_HOUSE, threeRank);
        }
        if (flush) {
            return (CLASS_FLUSH, RANK_ACE);
        }
        if (straightTop > 0) {
            return (CLASS_STRAIGHT, straightTop);
        }
        if (threeRank > 0) {
            return (CLASS_THREE_OF_A_KIND, threeRank);
        }
        if (firstPair > 0 && secondPair > 0) {
            return (CLASS_TWO_PAIR, firstPair);
        }
        if (firstPair > 0) {
            return (CLASS_PAIR, firstPair);
        }
        return (CLASS_HIGH_CARD, 0);
    }

    /* ========== HELPERS ========== */

    /// @notice Deck construction, Fisher-Yates shuffle, 5-card straight detection, and popcount
    /// all live in `CasinoHandsLib` (internal pure, inlined at compile time — no DELEGATECALL,
    /// no separate deployment, no storage). `_evaluateFive` itself stays local because its
    /// return shape (class + primary pair rank for Jacks-or-Better cutoff) is VP-specific

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
            uint256 amount,
            uint256 payout,
            uint256 placedAt,
            uint256 resolvedAt,
            BetStatus status,
            HandClass handClass,
            uint8 holdMask,
            uint256 multiplier
        )
    {
        Bet storage b = bets[betId];
        return (
            b.user,
            b.collateral,
            b.amount,
            b.payout,
            b.placedAt,
            b.resolvedAt,
            b.status,
            b.handClass,
            b.holdMask,
            b.multiplier
        );
    }

    function getBetCards(
        uint256 betId
    ) external view override returns (uint8[5] memory initialCards, uint8[5] memory finalCards) {
        Bet storage b = bets[betId];
        return (b.initialCards, b.finalCards);
    }

    function getFullRecord(uint256 betId) external view override returns (FullRecord memory r) {
        Bet storage b = bets[betId];
        r.betId = betId;
        r.user = b.user;
        r.collateral = b.collateral;
        r.amount = b.amount;
        r.payout = b.payout;
        r.placedAt = b.placedAt;
        r.resolvedAt = b.resolvedAt;
        r.status = b.status;
        r.handClass = b.handClass;
        r.holdMask = b.holdMask;
        r.multiplier = b.multiplier;
        r.initialCards = b.initialCards;
        r.finalCards = b.finalCards;
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

    function _checkBetSize(address collateral, uint256 amount) internal view {
        uint256 amountUsd = core.getUsdValue(collateral, amount);
        uint256 minBet = core.effectiveMinBetUsd(address(this));
        if (minBet == 0) minBet = MIN_BET_USD;
        if (amountUsd < minBet) revert InvalidAmount();
        uint256 maxBet = core.effectiveMaxBetUsd(address(this));
        if (maxBet != 0 && amountUsd > maxBet) revert AboveMaxBet();
    }

    /// @notice Worst-case net profit for this stake truncated by the per-game USD profit cap,
    /// returned in collateral units. Final payout at resolve is `stake + min(actualProfit, this)`
    function _cappedProfit(address collateral, uint256 amount) internal view returns (uint256) {
        uint256 worst = amount * (MAX_PAYOUT_MULT - 1);
        uint256 capCollateral = core.collateralFromUsd(collateral, core.effectiveMaxProfitUsd(address(this)));
        return worst > capCollateral ? capCollateral : worst;
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
