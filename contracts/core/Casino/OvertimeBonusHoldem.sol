// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoOvertimeBonusHoldem.sol";
import "./CasinoHandsLib.sol";

/// @title OvertimeBonusHoldem
/// @author Overtime
/// @notice Texas Hold'em Bonus / Casino Hold'em variant vs the dealer. Player posts ANTE
/// (required) + optional BONUS side bet. Pre-flop is "Play 2× or fold"; flop / turn / river each
/// allow one optional 1× raise or check. No dealer qualification. ANTE pays 1:1 only when the
/// final player hand is Straight or better; otherwise pushes on player win. Tie pushes all
/// main-game bets. Bonus side bet resolves independently from player + dealer hole cards
///
/// Staged VRF reveals cards only as needed by the upcoming decision — future cards are not in
/// storage before the player commits, so `eth_getStorageAt` peeks can't be used to gain edge
///
/// Locked paytables:
/// - Ante:  1:1 on Straight / Flush / FH / 4K / SF / Royal when player wins; push otherwise
/// - Plays: each (PreFlop 2× / Flop 1× / Turn 1× / River 1×) pays 1:1 on player win, pushes on
///   tie, loses on dealer win
/// - Bonus: AA-vs-AA 499:1 (capped from CoinPoker's 1000:1 to match VP/UTH 500× ceiling) /
///   AA 30:1 / AKs 25:1 / AQs|AJs 20:1 / AK 15:1 / JJ|QQ|KK 10:1 /
///   AQ|AJ 5:1 / 22-TT 3:1
contract OvertimeBonusHoldem is
    ICasinoOvertimeBonusHoldem,
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

    // Hand classes — same encoding as VideoPoker / UTH. Mirrored from `CasinoHandsLib.CLASS_*`
    // for `_antePayoutMult` readability (only CLASS_STRAIGHT is actually referenced locally;
    // the rest are kept for documentation of the encoding the library returns)
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
    uint8 private constant RANK_TEN = 10;
    uint8 private constant RANK_JACK = 11;
    uint8 private constant RANK_QUEEN = 12;
    uint8 private constant RANK_KING = 13;
    uint8 private constant RANK_ACE = 14;

    // Raise sizes (multipliers on ante)
    uint256 private constant PRE_FLOP_PLAY_MULT = 2;
    uint256 private constant POST_FLOP_RAISE_MULT = 1;

    /// @notice Worst-case NET PROFIT per ANTE unit (= total return - total stake-out, in "for 1"):
    ///   - Ante 1:1 win (Flush+) profit = 1× ante     (return 2× - stake 1×)
    ///   - Play 2× stake × 1:1 win profit = 2× ante   (return 4× - stake 2×)
    ///   - Flop 1× stake × 1:1 win profit = 1× ante
    ///   - Turn 1× stake × 1:1 win profit = 1× ante
    ///   - River 1× stake × 1:1 win profit = 1× ante
    /// Total max main-game profit = 6× ante. Bonus side adds up to 499× bonus profit on its own
    uint256 private constant MAX_MAIN_PROFIT_PER_ANTE = 6;

    /// @notice Bonus paytable in "for 1" semantics (totalReturn = stake × mult on win). Anything
    /// not matched loses (mult = 0). Top tier capped at 500× to match the project-wide ceiling
    /// used by VideoPoker (Royal=500) and UTH Blind (Royal=500); the original CoinPoker spec is
    /// "1000:1" but the $1000 per-bet profit cap already truncates above ~333× at $3 stake, so
    /// the displayed-but-unreachable 1000× would be misleading
    uint256 private constant BONUS_MULT_AA_VS_AA = 500;
    uint256 private constant BONUS_MULT_AA = 31;
    uint256 private constant BONUS_MULT_AK_SUITED = 26;
    uint256 private constant BONUS_MULT_AQ_AJ_SUITED = 21;
    uint256 private constant BONUS_MULT_AK_OFF = 16;
    uint256 private constant BONUS_MULT_JJ_QQ_KK = 11;
    uint256 private constant BONUS_MULT_AQ_AJ_OFF = 6;
    uint256 private constant BONUS_MULT_LOW_PAIR = 4; // 22 through 10-10
    uint256 private constant MAX_BONUS_MULT = BONUS_MULT_AA_VS_AA;

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
    /// @notice Reverted when `placeBetWithFreeBet` is called with a non-zero `bonusAmount`.
    /// The Bonus side bet's free-bet stake would otherwise be refunded via the FBH split on a
    /// winning main game, paying the user back for a losing-bonus leg as if no loss occurred
    error BonusNotAllowedForFreeBet();

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 anteAmount;
        uint256 bonusAmount;
        uint256 playAmount; // 2× ante if pre-flop Play taken, 0 if folded pre-flop
        uint256 flopRaise; // 1× ante if raised on flop
        uint256 turnRaise; // 1× ante if raised on turn
        uint256 riverRaise; // 1× ante if raised on river
        uint256 totalPayout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reservation;
        uint256 requestId;
        uint8[2] playerHole;
        uint8[5] community;
        uint8[2] dealerHole;
        BetStatus status;
        Outcome outcome;
        // Per-leg payout breakdown (FE rendering)
        uint256 antePayout;
        uint256 bonusPayout;
        uint256 playPayout;
        uint256 flopPayout;
        uint256 turnPayout;
        uint256 riverPayout;
        // Free-bet flag — stake legs pulled from FBH instead of user wallet. All settlements
        // route through FBH; referrer payments suppressed on net loss
        bool isFreeBet;
        // Set true when the player folded at some street. AWAITING_RESOLVE then deals dealer
        // hole only and skips showdown comparison — all main legs already lost
        bool folded;
        // Count of community cards revealed so far (0, 3, 4, or 5). Used by `_onResolve` to
        // build the dealer-hole exclusion mask correctly — `community[i] != 0` is unreliable
        // because card index 0 (2♣) is a legal card
        uint8 communityCount;
        // Per-bet profit cap (collateral units). See `_cappedProfit`
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

    /// @inheritdoc ICasinoOvertimeBonusHoldem
    function placeBet(
        address collateral,
        uint256 anteAmount,
        uint256 bonusAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(msg.sender, collateral, anteAmount, bonusAmount, referrer, false);
    }

    /// @inheritdoc ICasinoOvertimeBonusHoldem
    function placeBetWithFreeBet(
        address collateral,
        uint256 anteAmount,
        uint256 bonusAmount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(msg.sender, collateral, anteAmount, bonusAmount, referrer, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint256 anteAmount,
        uint256 bonusAmount,
        address referrer,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        if (anteAmount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        // Free-bet flow cannot bundle the optional Bonus side bet. The bonus would otherwise be
        // pulled from FBH along with the ante, and on a winning main game its lost stake would
        // be returned to the user via the FBH stake-back split — effectively paying the user
        // back 1:1 for a losing-bonus leg. Disallow rather than add a side-of-totalPay carve-out;
        // matches how TCP's PairPlus is separately settled (no free-bet refund on a losing PP)
        if (isFreeBet && bonusAmount > 0) revert BonusNotAllowedForFreeBet();
        _checkBetSize(collateral, anteAmount, bonusAmount);
        uint256 cappedProfit = _cappedProfit(collateral, anteAmount, bonusAmount);

        // Pull ANTE + BONUS upfront. Raises pull additional stake on demand at each street
        uint256 stakeIn = anteAmount + bonusAmount;
        if (isFreeBet) {
            core.useFreeBet(user, collateral, stakeIn);
        } else {
            core.pullFromUser(user, collateral, stakeIn);
        }
        if (referrer != address(0)) core.setReferrer(referrer, user);

        // Reservation = stakes_pulled_so_far + capped net-profit budget. Raises top up later
        uint256 reservation = stakeIn + cappedProfit;
        core.reserveOrRevert(collateral, reservation);

        requestId = core.requestRandomWords(1);
        betId = nextBetId++;

        Bet storage b = bets[betId];
        b.user = user;
        b.collateral = collateral;
        b.anteAmount = anteAmount;
        b.bonusAmount = bonusAmount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.status = BetStatus.AWAITING_HOLE;
        b.reservation = reservation;
        b.isFreeBet = isFreeBet;
        b.profitCapRemaining = cappedProfit;

        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        emit BetPlaced(betId, requestId, user, collateral, anteAmount, bonusAmount);
    }

    /* ========== DECISIONS ========== */

    function playPreFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.PRE_FLOP_TURN);
        _pullRaiseStake(b, PRE_FLOP_PLAY_MULT);
        b.playAmount = b.anteAmount * PRE_FLOP_PLAY_MULT;
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_FLOP);
        emit PlayedPreFlop(betId, requestId, b.user, b.playAmount);
    }

    function foldPreFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.PRE_FLOP_TURN);
        return _markFoldAndRequestResolve(betId, b);
    }

    function raiseFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.FLOP_TURN);
        _pullRaiseStake(b, POST_FLOP_RAISE_MULT);
        b.flopRaise = b.anteAmount * POST_FLOP_RAISE_MULT;
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_TURN);
        emit RaisedFlop(betId, requestId, b.user, b.flopRaise);
    }

    function checkFlop(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.FLOP_TURN);
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_TURN);
        emit CheckedFlop(betId, requestId, b.user);
    }

    function raiseTurn(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.TURN_TURN);
        _pullRaiseStake(b, POST_FLOP_RAISE_MULT);
        b.turnRaise = b.anteAmount * POST_FLOP_RAISE_MULT;
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_RIVER);
        emit RaisedTurn(betId, requestId, b.user, b.turnRaise);
    }

    function checkTurn(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.TURN_TURN);
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_RIVER);
        emit CheckedTurn(betId, requestId, b.user);
    }

    function raiseRiver(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.RIVER_TURN);
        _pullRaiseStake(b, POST_FLOP_RAISE_MULT);
        b.riverRaise = b.anteAmount * POST_FLOP_RAISE_MULT;
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_RESOLVE);
        emit RaisedRiver(betId, requestId, b.user, b.riverRaise);
    }

    function checkRiver(uint256 betId) external override nonReentrant notPaused returns (uint256 requestId) {
        Bet storage b = bets[betId];
        _requireOwnedAt(b, BetStatus.RIVER_TURN);
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_RESOLVE);
        emit CheckedRiver(betId, requestId, b.user);
    }

    /// @dev Shared fold path: emit, mark, advance to AWAITING_RESOLVE with dealer-hole-only VRF.
    /// Only `foldPreFlop` uses this — post-flop folds were removed because `checkFlop`/`checkTurn`/
    /// `checkRiver` are free, making any fold after the flop strictly dominated in money EV (lose
    /// ante guaranteed vs free chance to win at showdown)
    function _markFoldAndRequestResolve(uint256 betId, Bet storage b) internal returns (uint256 requestId) {
        BetStatus prior = b.status;
        b.folded = true;
        requestId = _requestVrf(betId, b, BetStatus.AWAITING_RESOLVE);
        emit Folded(betId, b.user, prior);
    }

    /* ========== CANCEL ========== */

    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (
            b.status != BetStatus.AWAITING_HOLE &&
            b.status != BetStatus.AWAITING_FLOP &&
            b.status != BetStatus.AWAITING_TURN &&
            b.status != BetStatus.AWAITING_RIVER &&
            b.status != BetStatus.AWAITING_RESOLVE
        ) revert InvalidBetStatus();
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
        if (b.requestId != 0) delete requestIdToBetId[b.requestId];

        // Refund every stake that's been pulled so far. ante + bonus pulled at place, then
        // playAmount/flopRaise/turnRaise/riverRaise on raises
        uint256 refund = b.anteAmount + b.bonusAmount + b.playAmount + b.flopRaise + b.turnRaise + b.riverRaise;

        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        core.payOut(b.user, b.collateral, refund, b.isFreeBet, refund);
        core.recordSettlement(b.collateral, refund, refund);

        b.totalPayout = refund;
        b.status = BetStatus.CANCELLED;
        b.resolvedAt = block.timestamp;
        emit BetCancelled(betId, b.user, refund, adminCancelled);
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
        BetStatus s = b.status;

        if (s == BetStatus.AWAITING_HOLE) {
            _onHoleDealt(betId, b, word);
        } else if (s == BetStatus.AWAITING_FLOP) {
            _onFlopDealt(betId, b, word);
        } else if (s == BetStatus.AWAITING_TURN) {
            _onTurnDealt(betId, b, word);
        } else if (s == BetStatus.AWAITING_RIVER) {
            _onRiverDealt(betId, b, word);
        } else if (s == BetStatus.AWAITING_RESOLVE) {
            _onResolve(betId, b, word);
        }
        // any other state: stale callback, ignore
    }

    function _onHoleDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE, 0);
        CasinoHandsLib.partialFisherYates(deck, HOLE_CARDS, word);
        b.playerHole[0] = deck[0];
        b.playerHole[1] = deck[1];
        b.status = BetStatus.PRE_FLOP_TURN;
        emit PlayerHoleDealt(betId, b.requestId, b.user, deck[0], deck[1]);
    }

    function _onFlopDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint64 mask = _holeMask(b);
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE - HOLE_CARDS, mask);
        CasinoHandsLib.partialFisherYates(deck, FLOP_CARDS, word);
        b.community[0] = deck[0];
        b.community[1] = deck[1];
        b.community[2] = deck[2];
        b.communityCount = 3;
        b.status = BetStatus.FLOP_TURN;
        emit FlopDealt(betId, b.requestId, b.user, deck[0], deck[1], deck[2]);
    }

    function _onTurnDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint64 mask = _holeFlopMask(b);
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE - HOLE_CARDS - FLOP_CARDS, mask);
        CasinoHandsLib.partialFisherYates(deck, 1, word);
        b.community[3] = deck[0];
        b.communityCount = 4;
        b.status = BetStatus.TURN_TURN;
        emit TurnDealt(betId, b.requestId, b.user, deck[0]);
    }

    function _onRiverDealt(uint256 betId, Bet storage b, uint256 word) internal {
        uint64 mask = _holeFlopMask(b) | (uint64(1) << b.community[3]);
        uint8[] memory deck = CasinoHandsLib.initDeck(DECK_SIZE - HOLE_CARDS - FLOP_CARDS - 1, mask);
        CasinoHandsLib.partialFisherYates(deck, 1, word);
        b.community[4] = deck[0];
        b.communityCount = 5;
        b.status = BetStatus.RIVER_TURN;
        emit RiverDealt(betId, b.requestId, b.user, deck[0]);
    }

    function _onResolve(uint256 betId, Bet storage b, uint256 word) internal {
        // Deal dealer hole only. Exclusion mask = player hole + however many community cards
        // were dealt before this VRF fired (tracked by `communityCount` since card 0 = 2♣ is
        // a valid card and can't be distinguished from "not dealt" via value alone)
        uint64 mask = _holeMask(b);
        uint8 cc = b.communityCount;
        for (uint8 i; i < cc; ++i) {
            mask |= uint64(1) << b.community[i];
        }
        uint8 deckSize = DECK_SIZE - HOLE_CARDS - cc;
        uint8[] memory deck = CasinoHandsLib.initDeck(deckSize, mask);
        CasinoHandsLib.partialFisherYates(deck, 2, word);
        b.dealerHole[0] = deck[0];
        b.dealerHole[1] = deck[1];

        _settle(betId, b);
    }

    /* ========== SETTLEMENT ========== */

    function _settle(uint256 betId, Bet storage b) internal {
        // Bonus: pays from player + dealer hole only (always evaluated)
        uint256 bonusPay = _evaluateBonusPayout(b);

        uint256 stakeOut = _totalStake(b);
        uint256 mainPay = 0;
        Outcome outcome;

        if (b.folded) {
            outcome = Outcome.FOLDED;
            // Main game lost; bonus alone might still pay
        } else {
            // Need to evaluate hands and compare. Build 7-card sets for player and dealer
            uint8[7] memory pSeven;
            uint8[7] memory dSeven;
            for (uint8 i; i < 2; ++i) {
                pSeven[i] = b.playerHole[i];
                dSeven[i] = b.dealerHole[i];
            }
            for (uint8 i; i < 5; ++i) {
                pSeven[i + 2] = b.community[i];
                dSeven[i + 2] = b.community[i];
            }
            uint256 pVal = CasinoHandsLib.evaluateCards7(CasinoHandsLib.toMemArray7(pSeven));
            uint256 dVal = CasinoHandsLib.evaluateCards7(CasinoHandsLib.toMemArray7(dSeven));

            if (pVal > dVal) {
                outcome = Outcome.PLAYER_WIN;
                // Ante: 1:1 on Straight+ (mult=2), push on lower wins (mult=1)
                uint256 anteMult = _antePayoutMult(pVal);
                b.antePayout = b.anteAmount * anteMult;
                b.playPayout = b.playAmount * 2; // 1:1 win (mult=2 in "for 1")
                b.flopPayout = b.flopRaise * 2;
                b.turnPayout = b.turnRaise * 2;
                b.riverPayout = b.riverRaise * 2;
            } else if (pVal < dVal) {
                outcome = Outcome.DEALER_WIN;
                // All main legs lose (paid 0)
            } else {
                outcome = Outcome.TIE;
                // Main legs push (stake-back)
                b.antePayout = b.anteAmount;
                b.playPayout = b.playAmount;
                b.flopPayout = b.flopRaise;
                b.turnPayout = b.turnRaise;
                b.riverPayout = b.riverRaise;
            }
            mainPay = b.antePayout + b.playPayout + b.flopPayout + b.turnPayout + b.riverPayout;
        }

        b.bonusPayout = bonusPay;
        uint256 totalPay = mainPay + bonusPay;

        // Soft-cap net profit. Truncate the variance-heavy Bonus leg first (top tier lives here)
        if (totalPay > stakeOut) {
            uint256 profit = totalPay - stakeOut;
            if (profit > b.profitCapRemaining) {
                uint256 cut = profit - b.profitCapRemaining;
                if (b.bonusPayout >= cut) {
                    b.bonusPayout -= cut;
                    bonusPay = b.bonusPayout;
                } else {
                    cut -= b.bonusPayout;
                    bonusPay = 0;
                    b.bonusPayout = 0;
                    if (b.antePayout >= cut) {
                        b.antePayout -= cut;
                    } else {
                        cut -= b.antePayout;
                        b.antePayout = 0;
                        // Spill into play legs in deterministic order
                        if (b.playPayout >= cut) b.playPayout -= cut;
                        else {
                            cut -= b.playPayout;
                            b.playPayout = 0;
                            if (b.flopPayout >= cut) b.flopPayout -= cut;
                            else {
                                cut -= b.flopPayout;
                                b.flopPayout = 0;
                                if (b.turnPayout >= cut) b.turnPayout -= cut;
                                else {
                                    cut -= b.turnPayout;
                                    b.turnPayout = 0;
                                    // Invariant: profitCapRemaining ≤ sum_of_leg_profits, so
                                    // `cut` must be fully absorbable by this point. If a future
                                    // refactor breaks the invariant, this subtraction reverts
                                    // (underflow) instead of silently dropping the remainder
                                    b.riverPayout -= cut;
                                }
                            }
                        }
                    }
                }
                profit = b.profitCapRemaining;
            }
            totalPay = stakeOut + profit;
            b.profitCapRemaining -= profit;
            // Recompute from stored leg fields so the emitted `mainPay` always equals the
            // visible per-leg sum after cap reductions
            bonusPay = b.bonusPayout;
            mainPay = b.antePayout + b.playPayout + b.flopPayout + b.turnPayout + b.riverPayout;
        }

        // Release reservation & pay
        core.releaseReservation(b.collateral, b.reservation);
        b.reservation = 0;

        if (totalPay > 0) {
            core.payOut(b.user, b.collateral, totalPay, b.isFreeBet, stakeOut);
        }
        core.recordSettlement(b.collateral, stakeOut, totalPay);

        if (totalPay < stakeOut && !b.isFreeBet) {
            core.payReferrer(b.user, b.collateral, stakeOut - totalPay);
        }

        b.outcome = outcome;
        b.totalPayout = totalPay;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit BetResolved(
            betId,
            b.requestId,
            b.user,
            outcome,
            b.dealerHole[0],
            b.dealerHole[1],
            b.antePayout,
            b.bonusPayout,
            mainPay,
            totalPay
        );
    }

    function _totalStake(Bet storage b) internal view returns (uint256) {
        return b.anteAmount + b.bonusAmount + b.playAmount + b.flopRaise + b.turnRaise + b.riverRaise;
    }

    /// @notice Ante paytable: 1:1 on Straight+ when player wins (mult = 2 in "for 1"), push on
    /// lower wins (mult = 1 = stake-back only)
    function _antePayoutMult(uint256 handValue) internal pure returns (uint256) {
        uint8 class_ = uint8(handValue >> 20);
        if (class_ >= CLASS_STRAIGHT) return 2;
        return 1;
    }

    /// @notice Bonus payout based on player + dealer hole cards. Highest applicable prize wins
    function _evaluateBonusPayout(Bet storage b) internal view returns (uint256) {
        if (b.bonusAmount == 0) return 0;

        // Extract ranks/suits for both holes
        uint8 pr0 = (b.playerHole[0] % 13) + RANK_TWO;
        uint8 pr1 = (b.playerHole[1] % 13) + RANK_TWO;
        uint8 ps0 = b.playerHole[0] / 13;
        uint8 ps1 = b.playerHole[1] / 13;
        uint8 dr0 = (b.dealerHole[0] % 13) + RANK_TWO;
        uint8 dr1 = (b.dealerHole[1] % 13) + RANK_TWO;

        uint256 mult = _bonusMult(pr0, pr1, ps0, ps1, dr0, dr1);
        if (mult == 0) return 0;
        return b.bonusAmount * mult;
    }

    /// @dev Decision tree for the bonus paytable. Highest qualifying tier wins
    function _bonusMult(uint8 pr0, uint8 pr1, uint8 ps0, uint8 ps1, uint8 dr0, uint8 dr1) internal pure returns (uint256) {
        bool playerAA = (pr0 == RANK_ACE && pr1 == RANK_ACE);
        bool dealerAA = (dr0 == RANK_ACE && dr1 == RANK_ACE);
        if (playerAA && dealerAA) return BONUS_MULT_AA_VS_AA;
        if (playerAA) return BONUS_MULT_AA;

        // Suited Ace combos (player only)
        bool suited = (ps0 == ps1);
        uint8 hi = pr0 >= pr1 ? pr0 : pr1;
        uint8 lo = pr0 >= pr1 ? pr1 : pr0;
        bool isPair = (pr0 == pr1);

        if (!isPair && hi == RANK_ACE) {
            if (suited) {
                if (lo == RANK_KING) return BONUS_MULT_AK_SUITED;
                if (lo == RANK_QUEEN || lo == RANK_JACK) return BONUS_MULT_AQ_AJ_SUITED;
            } else {
                if (lo == RANK_KING) return BONUS_MULT_AK_OFF;
                if (lo == RANK_QUEEN || lo == RANK_JACK) return BONUS_MULT_AQ_AJ_OFF;
            }
            return 0;
        }

        // Pair-based tiers
        if (isPair) {
            if (pr0 == RANK_JACK || pr0 == RANK_QUEEN || pr0 == RANK_KING) return BONUS_MULT_JJ_QQ_KK;
            if (pr0 >= RANK_TWO && pr0 <= RANK_TEN) return BONUS_MULT_LOW_PAIR;
        }

        return 0;
    }

    /* ========== HELPERS ========== */

    /// @notice Deck construction, Fisher-Yates shuffle, 7-card hand evaluator, top-N rank
    /// helpers, popcount, and value packing all live in `CasinoHandsLib` (internal pure,
    /// inlined at compile time — no DELEGATECALL, no separate deployment, no storage)

    function _holeMask(Bet storage b) internal view returns (uint64) {
        return (uint64(1) << b.playerHole[0]) | (uint64(1) << b.playerHole[1]);
    }

    function _holeFlopMask(Bet storage b) internal view returns (uint64) {
        return _holeMask(b) | (uint64(1) << b.community[0]) | (uint64(1) << b.community[1]) | (uint64(1) << b.community[2]);
    }

    /* ========== STAKE / SIZING ========== */

    /// @dev Free-bet raises pull additional stake from FBH (not the user's wallet). If the
    /// user's FBH balance is exhausted, every raise tx reverts and the user can only
    /// check/fold from that point (or wait out `cancelTimeout`). FE must gate raise buttons
    /// on remaining FBH balance for free-bet hands — there is no wallet-funded raise path
    function _pullRaiseStake(Bet storage b, uint256 mult) internal {
        uint256 raiseStake = b.anteAmount * mult;
        if (b.isFreeBet) core.useFreeBet(b.user, b.collateral, raiseStake);
        else core.pullFromUser(b.user, b.collateral, raiseStake);
        core.reserveOrRevert(b.collateral, raiseStake);
        b.reservation += raiseStake;
    }

    function _requestVrf(uint256 betId, Bet storage b, BetStatus next) internal returns (uint256 requestId) {
        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = next;
        requestIdToBetId[requestId] = betId;
    }

    /// @notice Per-game bet-size gate. `MIN_BET_USD` floor applies to the required Ante AND, when
    /// present (> 0), the optional Bonus side bet — symmetric floor blocks dust Bonus bets that
    /// produce negligible payouts but still consume the full per-bet gas/VRF overhead. Bonus = 0
    /// still bypasses the check entirely (skip the side bet)
    function _checkBetSize(address collateral, uint256 anteAmount, uint256 bonusAmount) internal view {
        uint256 anteUsd = core.getUsdValue(collateral, anteAmount);
        uint256 minBet = core.effectiveMinBetUsd(address(this));
        if (minBet == 0) minBet = MIN_BET_USD;
        if (anteUsd < minBet) revert InvalidAmount();
        uint256 maxBet = core.effectiveMaxBetUsd(address(this));
        if (maxBet != 0 && anteUsd > maxBet) revert AboveMaxBet();
        if (bonusAmount > 0) {
            uint256 bonusUsd = core.getUsdValue(collateral, bonusAmount);
            if (bonusUsd < minBet) revert InvalidAmount();
            if (maxBet != 0 && bonusUsd > maxBet) revert AboveMaxBet();
        }
    }

    /// @notice Worst-case net profit cap (collateral units). Main game contributes
    /// `MAX_MAIN_PROFIT_PER_ANTE × ante` of profit (6× — see constant doc); bonus contributes
    /// `(MAX_BONUS_MULT - 1) × bonus`. Subtract 1 from bonus mult because the "for 1" multiplier
    /// already includes stake-back, so profit = (mult - 1) × stake. Truncated to per-game USD cap
    function _cappedProfit(address collateral, uint256 anteAmount, uint256 bonusAmount) internal view returns (uint256) {
        uint256 worst = anteAmount * MAX_MAIN_PROFIT_PER_ANTE + bonusAmount * (MAX_BONUS_MULT - 1);
        uint256 capCollateral = core.collateralFromUsd(collateral, core.effectiveMaxProfitUsd(address(this)));
        return worst > capCollateral ? capCollateral : worst;
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
            uint256 bonusAmount,
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
            b.bonusAmount,
            b.totalPayout,
            b.placedAt,
            b.resolvedAt,
            b.status,
            b.outcome
        );
    }

    function getFullRecord(uint256 betId) external view override returns (FullRecord memory r) {
        Bet storage b = bets[betId];
        r.betId = betId;
        r.user = b.user;
        r.collateral = b.collateral;
        r.anteAmount = b.anteAmount;
        r.bonusAmount = b.bonusAmount;
        r.playAmount = b.playAmount;
        r.flopRaise = b.flopRaise;
        r.turnRaise = b.turnRaise;
        r.riverRaise = b.riverRaise;
        r.totalPayout = b.totalPayout;
        r.antePayout = b.antePayout;
        r.bonusPayout = b.bonusPayout;
        r.playPayout = b.playPayout;
        r.flopPayout = b.flopPayout;
        r.turnPayout = b.turnPayout;
        r.riverPayout = b.riverPayout;
        r.placedAt = b.placedAt;
        r.resolvedAt = b.resolvedAt;
        r.status = b.status;
        r.outcome = b.outcome;
        r.playerHole = b.playerHole;
        r.community = b.community;
        r.dealerHole = b.dealerHole;
        r.isFreeBet = b.isFreeBet;
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

    /* ========== MODIFIERS / INTERNAL GUARDS ========== */

    function _requireOwnedAt(Bet storage b, BetStatus expected) internal view {
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != expected) revert InvalidBetStatus();
    }

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
