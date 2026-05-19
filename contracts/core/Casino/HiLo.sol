// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ICasinoCoreV2.sol";
import "../../interfaces/ICasinoGameCallback.sol";
import "../../interfaces/ICasinoHiLo.sol";
import "./CasinoHandsLib.sol";

/// @title HiLo
/// @author Overtime
/// @notice "Above/below 8" card-guess run with cashout. Each round the player picks ABOVE or
/// BELOW the rank-6 midpoint (card "8"); a fresh card is drawn from a 52-card deck; correct
/// guesses multiply the running multiplier by a constant factor; wrong guess loses the bet;
/// cashout pays `bet * multiplier`. Drawing card "8" is a push (multiplier unchanged, run continues)
/// @dev No "current card" feeds into the decision — the comparison point is always rank 6. Per-
/// correct-guess factor is constant: `factor = (12 - 13*HE) / 6` in 1e18 precision (≈ 1.96x at
/// HE=2%). Per-bet liability capped by `maxMultiplierE18`. Cards are drawn fresh each guess
/// (no without-replacement tracking)
contract HiLo is ICasinoHiLo, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant DECK_SIZE = 52;

    /// @notice Reference rank for the above/below decision. Rank 6 is card "8" (rank 0 = "2",
    /// rank 12 = "Ace"). Splits the deck symmetrically: 6 ranks below (2-7), 6 above (9-A), 1
    /// push (8 itself). Probability of correct guess = 6/13 per round
    uint8 private constant MIDPOINT_RANK = 6;
    uint8 private constant WINNING_RANKS_PER_DIRECTION = 6;

    uint256 public constant MIN_HOUSE_EDGE_E18 = 0.02e18;
    uint256 public constant MAX_HOUSE_EDGE_E18 = 0.05e18;

    /// @notice Default per-bet multiplier cap. With a constant ≈1.96x per win, 25x corresponds to
    /// ~5 consecutive wins. Realistic 99th-percentile cashouts sit well below this
    uint256 public constant DEFAULT_MAX_MULTIPLIER_E18 = 25e18;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error AboveMaxBet();
    error MaxMultiplierReached();
    error MaxProfitExceeded();
    error InvalidHouseEdge();
    error BetNotFound();
    error BetNotOwner();
    error InvalidBetStatus();
    /// @notice Reverted by `makeAction` when an unknown action code is supplied. Defends against
    /// FE / gasless-session bugs that send a stale or out-of-range code; the call reverts
    /// instead of silently no-op'ing past the if/else chain
    error InvalidAction();

    /* ========== STRUCTS ========== */

    struct Bet {
        address user;
        address collateral;
        uint256 amount;
        uint256 payout;
        uint256 placedAt;
        uint256 lastRequestAt;
        uint256 resolvedAt;
        uint256 reserved;
        uint256 requestId;
        uint256 currentMultiplierE18;
        uint8 lastCard; // last drawn card (0..51); 0xFF if no card drawn yet
        uint8 guessCount;
        uint8 correctCount;
        uint8 pushCount;
        Direction pendingDirection;
        BetStatus status;
        Outcome outcome;
        // --- per-turn history (Bet-struct extension; storage-safe append for upgrade) ---
        // Parallel arrays for FE rendering of the full bet history without log scanning.
        // `directions` has one entry per submitted guess (length = `guessCount`). `cards`,
        // `outcomes`, `multipliersE18` have one entry per resolved card (length = `guessCount`
        // when no VRF in flight, or `guessCount - 1` while AWAITING_NEXT_CARD).
        // `multipliersE18[i]` holds the multiplier AFTER turn i (HIT advances; PUSH copies
        // prior; BUST writes the frozen pre-bust value)
        uint8[] directions;
        uint8[] cards;
        uint8[] outcomes; // CardOutcome cast to uint8
        uint256[] multipliersE18;
        // --- free bet flag. Set when stake was pulled from FreeBetsHolder via core.useFreeBet
        // instead of core.pullFromUser. Routes payouts back to FBH on resolve and suppresses
        // referrer payment on BUST (no real loss to user)
        bool isFreeBet;
    }

    /* ========== STATE ========== */

    ICasinoCoreV2 public core;
    ISportsAMMV2Manager public manager;

    uint256 public houseEdgeE18;
    uint256 public maxMultiplierE18;

    uint256 public nextBetId;

    mapping(uint256 => Bet) internal bets;
    mapping(uint256 => uint256) public requestIdToBetId;
    mapping(address => uint256[]) private userBetIds;

    /* ========== INITIALIZER ========== */

    function initialize(address _owner, address _core, address _manager) external initializer {
        if (_owner == address(0) || _core == address(0) || _manager == address(0)) revert InvalidAddress();
        setOwner(_owner);
        initNonReentrant();
        core = ICasinoCoreV2(_core);
        manager = ISportsAMMV2Manager(_manager);
        nextBetId = 1;
        houseEdgeE18 = MIN_HOUSE_EDGE_E18;
        maxMultiplierE18 = DEFAULT_MAX_MULTIPLIER_E18;
    }

    /* ========== PLACE / GUESS / CASHOUT ========== */

    /// @notice Places a HiLo bet and submits the first guess in one transaction. The bet starts
    /// in AWAITING_NEXT_CARD with the first VRF request already in flight. Subsequent rounds use
    /// `makeAction(betId, action)` once the bet returns to PLAYER_TURN
    function placeBet(
        address collateral,
        uint256 amount,
        address referrer,
        Direction firstDirection,
        bool isFreeBet
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        return _placeBet(collateral, amount, referrer, firstDirection, isFreeBet);
    }

    function _placeBet(
        address collateral,
        uint256 amount,
        address referrer,
        Direction firstDirection,
        bool isFreeBet
    ) internal returns (uint256 betId, uint256 requestId) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();
        _checkBetSize(collateral, amount);

        uint256 amountUsd = core.getUsdValue(collateral, amount);
        uint256 worstHouseProfitUsd = (amountUsd * (maxMultiplierE18 - ONE)) / ONE;
        if (worstHouseProfitUsd > core.effectiveMaxProfitUsd(address(this))) revert MaxProfitExceeded();

        if (isFreeBet) {
            core.useFreeBet(msg.sender, collateral, amount);
        } else {
            core.pullFromUser(msg.sender, collateral, amount);
        }
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);

        uint256 reservation = (amount * maxMultiplierE18) / ONE;
        core.reserveOrRevert(collateral, reservation);

        betId = nextBetId++;
        requestId = core.requestRandomWords(1);

        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.amount = amount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.reserved = reservation;
        b.currentMultiplierE18 = ONE; // 1.00x to start
        b.lastCard = 0xFF; // sentinel: no card drawn yet
        b.requestId = requestId;
        b.pendingDirection = firstDirection;
        b.guessCount = 1;
        b.directions.push(uint8(firstDirection));
        b.status = BetStatus.AWAITING_NEXT_CARD;
        b.isFreeBet = isFreeBet;

        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);

        emit BetPlaced(betId, msg.sender, collateral, amount);
        emit GuessChosen(betId, requestId, msg.sender, firstDirection);
    }

    /// @notice Single-selector mid-game dispatcher. Routes by action code into the internal
    /// helpers — same auth, state machine, and events as the previously-public guess / cashout
    /// functions. Action codes:
    ///   0 = guess ABOVE
    ///   1 = guess BELOW
    ///   2 = cashout
    /// Reverts `InvalidAction` for any other code so a misconfigured FE fails loudly
    /// @dev AUDIT NOTE: `notPaused` here means a mid-game pause traps in-flight winners (e.g.
    /// a user at 15× multiplier can't cashout). Considered exempting settlement actions or adding
    /// a separate `settlementsPaused` flag; declined because `adminCancelBet` is the operator's
    /// escape hatch for stuck bets (full-stake refund, NOT accrued winnings — known trade-off)
    function makeAction(uint256 betId, uint8 action) external override nonReentrant notPaused returns (uint256 requestId) {
        if (action == 0) return _guess(betId, Direction.ABOVE);
        if (action == 1) return _guess(betId, Direction.BELOW);
        if (action == 2) {
            _cashout(betId);
            return 0;
        }
        revert InvalidAction();
    }

    function _guess(uint256 betId, Direction direction) internal returns (uint256 requestId) {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();

        // Cap reached → no more guesses
        if (b.currentMultiplierE18 >= maxMultiplierE18) revert MaxMultiplierReached();

        b.pendingDirection = direction;
        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = BetStatus.AWAITING_NEXT_CARD;
        ++b.guessCount;
        b.directions.push(uint8(direction));
        requestIdToBetId[requestId] = betId;

        emit GuessChosen(betId, requestId, msg.sender, direction);
    }

    function _cashout(uint256 betId) internal {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();

        uint256 mult = b.currentMultiplierE18;
        uint256 payout = (b.amount * mult) / ONE;

        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;
        if (payout > 0) {
            core.payOut(b.user, b.collateral, payout, b.isFreeBet, b.amount);
        }
        core.recordSettlement(b.collateral, b.amount, payout);

        b.payout = payout;
        b.outcome = Outcome.CASHED_OUT;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit CashedOut(betId, msg.sender, mult, payout);
        emit BetResolved(betId, msg.sender, Outcome.CASHED_OUT, payout);
    }

    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.PLAYER_TURN && b.status != BetStatus.AWAITING_NEXT_CARD) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];
        // Clear any in-flight VRF mapping so a late callback can't be matched back to this bet.
        // The bet's status check inside `onVrfFulfilled` already guards against double-spend
        // (cancelled bets early-return), but deleting the mapping avoids dangling storage and
        // is required hygiene for AWAITING_NEXT_CARD cancels (HiLo is multi-round, unlike the
        // other games whose cancel paths can only run with no VRF in flight)
        if (b.requestId != 0) delete requestIdToBetId[b.requestId];

        // Refund: original stake (running multiplier doesn't add stake; only the original bet
        // was pulled). Mid-run cancellation forfeits any accumulated multiplier. For free bets,
        // the refund routes back to FBH and credits the user's free-bet balance (reusable)
        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;
        core.payOut(b.user, b.collateral, b.amount, b.isFreeBet, b.amount);
        // Decrement core's pending-stake counter (stake == refund so zero P&L impact on the
        // breaker gauge — cancels don't generate house P&L)
        core.recordSettlement(b.collateral, b.amount, b.amount);
        b.payout = b.amount;
        b.status = BetStatus.CANCELLED;
        b.resolvedAt = block.timestamp;
        emit BetCancelled(betId, b.user, b.amount, adminCancelled);
    }

    /* ========== VRF CALLBACK ========== */

    /// @dev `nonReentrant` defends against malicious-token transfer hooks calling cashout/guess
    /// mid-callback (relevant on the wrong-guess branch where IERC20.transfer to referrer fires)
    function onVrfFulfilled(uint256 requestId, uint256[] calldata randomWords) external override nonReentrant {
        if (msg.sender != address(core)) revert InvalidSender();
        uint256 betId = requestIdToBetId[requestId];
        if (betId == 0) return;
        delete requestIdToBetId[requestId];

        Bet storage b = bets[betId];
        if (b.status != BetStatus.AWAITING_NEXT_CARD) return;

        uint8 newCard = uint8(randomWords[0] % DECK_SIZE);
        uint8 newRank = _rank(newCard);
        Direction dir = b.pendingDirection;

        bool isPush = newRank == MIDPOINT_RANK;
        bool isCorrect = !isPush &&
            ((dir == Direction.ABOVE && newRank > MIDPOINT_RANK) || (dir == Direction.BELOW && newRank < MIDPOINT_RANK));

        b.lastCard = newCard;
        b.cards.push(newCard);

        if (isPush) {
            ++b.pushCount;
            b.outcomes.push(uint8(CardOutcome.PUSH));
            b.multipliersE18.push(b.currentMultiplierE18); // unchanged
            b.status = BetStatus.PLAYER_TURN;
            emit NextCardDealt(betId, b.requestId, b.user, newCard, false, true, b.currentMultiplierE18);
        } else if (isCorrect) {
            ++b.correctCount;
            uint256 factor = _multiplierFactorE18();
            uint256 newMult = (b.currentMultiplierE18 * factor) / ONE;
            if (newMult > maxMultiplierE18) newMult = maxMultiplierE18;
            b.currentMultiplierE18 = newMult;
            b.outcomes.push(uint8(CardOutcome.HIT));
            b.multipliersE18.push(newMult);
            b.status = BetStatus.PLAYER_TURN;
            emit NextCardDealt(betId, b.requestId, b.user, newCard, true, false, newMult);
        } else {
            // Wrong guess — lose. Per-turn history records the pre-bust (frozen) multiplier so
            // FE can render "you were at Nx before busting". Skip referrer payment when the
            // bet was placed with a free bet — the user lost no real funds, so no referral fee
            uint256 frozenMult = b.currentMultiplierE18;
            b.outcomes.push(uint8(CardOutcome.BUST));
            b.multipliersE18.push(frozenMult);
            // CEI: write all terminal-state fields before any external call (defense beyond
            // `nonReentrant` — re-entry would see status=RESOLVED and bounce off the early-return)
            uint256 reserved = b.reserved;
            b.reserved = 0;
            b.outcome = Outcome.WRONG_GUESS;
            b.status = BetStatus.RESOLVED;
            b.resolvedAt = block.timestamp;
            core.releaseReservation(b.collateral, reserved);
            core.recordSettlement(b.collateral, b.amount, 0);
            if (!b.isFreeBet) {
                core.payReferrer(b.user, b.collateral, b.amount);
            }
            emit NextCardDealt(betId, b.requestId, b.user, newCard, false, false, 0);
            emit BetResolved(betId, b.user, Outcome.WRONG_GUESS, 0);
        }
    }

    /* ========== MULTIPLIER ========== */

    /// @inheritdoc ICasinoHiLo
    function multiplierFactorE18() external view override returns (uint256) {
        return _multiplierFactorE18();
    }

    /// @notice Per-correct-guess multiplier factor: `(12 - 13*HE) / 6` in 1e18 precision.
    /// Constant across rounds (no rank dependency in the above/below-8 game).
    /// At HE=2%: (12 - 0.26) / 6 = 1.9567x
    function _multiplierFactorE18() internal view returns (uint256) {
        return (12 * ONE - 13 * houseEdgeE18) / WINNING_RANKS_PER_DIRECTION;
    }

    function _rank(uint8 card) internal pure returns (uint8) {
        return card / 4;
    }

    /// @notice Per-game bet-size gate. `core.effectiveMinBetUsd` / `effectiveMaxBetUsd` overrides
    /// (set via `CasinoCoreV2.setMinBetPerGameUsd` / `setMaxBetPerGameUsd`) take precedence; when
    /// unset (zero), `MIN_BET_USD` is the default floor and there is no explicit max ceiling —
    /// the bet is still capped indirectly by `effectiveMaxProfitUsd` via the `MaxProfitExceeded`
    /// check in `_placeBet`
    function _checkBetSize(address collateral, uint256 amount) internal view {
        uint256 amountUsd = core.getUsdValue(collateral, amount);
        uint256 minBet = core.effectiveMinBetUsd(address(this));
        if (minBet == 0) minBet = MIN_BET_USD;
        if (amountUsd < minBet) revert InvalidAmount();
        uint256 maxBet = core.effectiveMaxBetUsd(address(this));
        if (maxBet != 0 && amountUsd > maxBet) revert AboveMaxBet();
    }

    /* ========== ADMIN ========== */

    /// @dev IN-FLIGHT BETS SEE THE NEW VALUE on subsequent guesses. There is no per-bet
    /// snapshot. Operator must pause the game (`setGamePaused` on core) and let pending bets
    /// settle before retuning. Raising `houseEdgeE18` mid-bet lowers the per-correct-guess
    /// factor for existing bets; lowering raises it. Either way it's user-unexpected
    function setHouseEdge(uint256 newHouseEdgeE18) external onlyOwner {
        if (newHouseEdgeE18 < MIN_HOUSE_EDGE_E18 || newHouseEdgeE18 > MAX_HOUSE_EDGE_E18) revert InvalidHouseEdge();
        houseEdgeE18 = newHouseEdgeE18;
    }

    /// @dev IN-FLIGHT BETS SEE THE NEW CAP. Reservations are sized at place time against the
    /// then-current cap; raising the cap mid-bet under-collateralizes existing bets (cashout
    /// can pay more than reserved). Operator must pause and let pending bets settle before
    /// raising. Lowering is safe (over-reserved) but still changes the user's max upside
    function setMaxMultiplier(uint256 newMaxE18) external onlyOwner {
        if (newMaxE18 < 2e18) revert InvalidAmount();
        maxMultiplierE18 = newMaxE18;
    }

    /// @dev AUDIT NOTE: unguarded against repointing to a malicious core (a compromised owner
    /// could swap to an EvilCore returning attacker-chosen randomness). Considered adding a
    /// registration check (`core.isGameRegistered(address(this))`) or a timelock; declined under
    /// trusted-owner model (multisig protects the key). Re-evaluate if the owner key surface widens
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
            Outcome outcome
        )
    {
        Bet storage b = bets[betId];
        return (b.user, b.collateral, b.amount, b.payout, b.placedAt, b.resolvedAt, b.status, b.outcome);
    }

    function getBetState(
        uint256 betId
    )
        external
        view
        override
        returns (uint8 lastCard, uint256 currentMultiplierE18, uint8 guessCount, uint8 correctCount, uint8 pushCount)
    {
        Bet storage b = bets[betId];
        return (b.lastCard, b.currentMultiplierE18, b.guessCount, b.correctCount, b.pushCount);
    }

    /// @inheritdoc ICasinoHiLo
    function getBetCards(
        uint256 betId
    )
        external
        view
        override
        returns (uint8[] memory directions, uint8[] memory cards, uint8[] memory outcomes, uint256[] memory multipliersE18)
    {
        Bet storage b = bets[betId];
        return (b.directions, b.cards, b.outcomes, b.multipliersE18);
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
        r.outcome = b.outcome;
        r.lastCard = b.lastCard;
        r.currentMultiplierE18 = b.currentMultiplierE18;
        r.guessCount = b.guessCount;
        r.correctCount = b.correctCount;
        r.pushCount = b.pushCount;
        r.isFreeBet = b.isFreeBet;
        r.lastRequestAt = b.lastRequestAt;
    }

    function getUserBetIds(address user, uint256 offset, uint256 limit) external view override returns (uint256[] memory) {
        return CasinoHandsLib.getUserBetIds(userBetIds[user], offset, limit);
    }

    function getRecentBetIds(uint256 offset, uint256 limit) external view override returns (uint256[] memory) {
        return CasinoHandsLib.getRecentBetIds(nextBetId, offset, limit);
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
