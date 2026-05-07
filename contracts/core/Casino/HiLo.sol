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

/// @title HiLo
/// @author Overtime
/// @notice Card-guess run with cashout. Player is shown a card; guesses higher/lower for the
/// next card; correct guesses multiply the running multiplier; wrong guess loses the bet;
/// cashout pays `bet * multiplier`. Equal-rank cards push (multiplier unchanged, run continues)
/// @dev Cards are drawn fresh from a 52-card deck each guess (no without-replacement tracking).
/// Multiplier per correct guess: `(12 - 13*HE) / countOfWinningRanks` in 1e18 precision.
/// At extreme ranks (0 or 12), only one direction is valid; the other reverts.
/// Per-bet liability capped by `maxMultiplierE18`
contract HiLo is ICasinoHiLo, ICasinoGameCallback, Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONSTANTS ========== */

    uint256 private constant ONE = 1e18;
    uint256 public constant MIN_BET_USD = 3e18;

    uint8 private constant DECK_SIZE = 52;
    uint8 private constant RANKS_PER_DECK = 13;

    uint256 public constant MIN_HOUSE_EDGE_E18 = 0.02e18;
    uint256 public constant MAX_HOUSE_EDGE_E18 = 0.05e18;

    uint256 public constant DEFAULT_MAX_MULTIPLIER_E18 = 1000e18;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidAmount();
    error InvalidCollateral();
    error InvalidDirection();
    error MaxMultiplierReached();
    error MaxProfitExceeded();
    error InvalidHouseEdge();
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
        uint256 reserved;
        uint256 requestId;
        uint256 currentMultiplierE18;
        uint8 currentCard;
        uint8 guessCount;
        uint8 correctCount;
        uint8 pushCount;
        Direction pendingDirection;
        BetStatus status;
        Outcome outcome;
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

    uint256[40] private __gap;

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

    function placeBet(
        address collateral,
        uint256 amount,
        address referrer
    ) external override nonReentrant notPaused returns (uint256 betId, uint256 requestId) {
        if (amount == 0) revert InvalidAmount();
        if (!core.supportedCollateral(collateral)) revert InvalidCollateral();

        uint256 amountUsd = core.getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        uint256 worstHouseProfitUsd = (amountUsd * (maxMultiplierE18 - ONE)) / ONE;
        if (worstHouseProfitUsd > core.maxProfitUsd()) revert MaxProfitExceeded();

        core.pullFromUser(msg.sender, collateral, amount);
        if (referrer != address(0)) core.setReferrer(referrer, msg.sender);

        uint256 reservation = (amount * maxMultiplierE18) / ONE;
        core.reserveOrRevert(collateral, reservation);

        requestId = core.requestRandomWords(1);
        betId = nextBetId++;

        Bet storage b = bets[betId];
        b.user = msg.sender;
        b.collateral = collateral;
        b.amount = amount;
        b.placedAt = block.timestamp;
        b.lastRequestAt = block.timestamp;
        b.requestId = requestId;
        b.reserved = reservation;
        b.currentMultiplierE18 = ONE; // 1.00x to start
        b.status = BetStatus.AWAITING_FIRST_CARD;

        requestIdToBetId[requestId] = betId;
        userBetIds[msg.sender].push(betId);

        emit BetPlaced(betId, requestId, msg.sender, collateral, amount);
    }

    function guess(uint256 betId, Direction direction) external override nonReentrant returns (uint256 requestId) {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();

        uint8 rank = _rank(b.currentCard);
        // Validate direction has nonzero probability
        if (direction == Direction.HIGHER && rank == RANKS_PER_DECK - 1) revert InvalidDirection();
        if (direction == Direction.LOWER && rank == 0) revert InvalidDirection();

        // Cap reached → no more guesses
        if (b.currentMultiplierE18 >= maxMultiplierE18) revert MaxMultiplierReached();

        b.pendingDirection = direction;
        requestId = core.requestRandomWords(1);
        b.requestId = requestId;
        b.lastRequestAt = block.timestamp;
        b.status = BetStatus.AWAITING_NEXT_CARD;
        ++b.guessCount;
        requestIdToBetId[requestId] = betId;

        emit GuessChosen(betId, requestId, msg.sender, direction, b.currentCard);
    }

    function cashout(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.PLAYER_TURN) revert InvalidBetStatus();

        uint256 mult = b.currentMultiplierE18;
        uint256 payout = (b.amount * mult) / ONE;

        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;
        if (payout > 0) {
            core.payOut(b.user, b.collateral, payout, false, b.amount);
        }
        core.recordSettlement(b.collateral, b.amount, payout);

        b.payout = payout;
        b.outcome = Outcome.CASHED_OUT;
        b.status = BetStatus.RESOLVED;
        b.resolvedAt = block.timestamp;

        emit CashedOut(betId, msg.sender, mult, payout);
        emit BetResolved(betId, msg.sender, Outcome.CASHED_OUT, payout);
    }

    function cancelBet(uint256 betId) external override nonReentrant {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.user != msg.sender) revert BetNotOwner();
        if (b.status != BetStatus.AWAITING_FIRST_CARD && b.status != BetStatus.AWAITING_NEXT_CARD) revert InvalidBetStatus();
        if (block.timestamp < b.lastRequestAt + core.cancelTimeout()) revert CancelTimeoutNotReached();
        _cancelBet(betId, false);
    }

    function adminCancelBet(uint256 betId) external override nonReentrant onlyResolver {
        Bet storage b = bets[betId];
        if (b.status == BetStatus.NONE) revert BetNotFound();
        if (b.status != BetStatus.AWAITING_FIRST_CARD && b.status != BetStatus.AWAITING_NEXT_CARD) revert InvalidBetStatus();
        _cancelBet(betId, true);
    }

    function _cancelBet(uint256 betId, bool adminCancelled) internal {
        Bet storage b = bets[betId];
        // Refund: original stake (running multiplier doesn't add stake; only the original bet
        // was pulled). Mid-run cancellation forfeits any accumulated multiplier
        core.releaseReservation(b.collateral, b.reserved);
        b.reserved = 0;
        core.payOut(b.user, b.collateral, b.amount, false, b.amount);
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
        uint8 newCard = uint8(randomWords[0] % DECK_SIZE);

        if (b.status == BetStatus.AWAITING_FIRST_CARD) {
            b.currentCard = newCard;
            b.status = BetStatus.PLAYER_TURN;
            emit FirstCardDealt(betId, b.requestId, b.user, newCard);
            return;
        }

        if (b.status == BetStatus.AWAITING_NEXT_CARD) {
            uint8 oldRank = _rank(b.currentCard);
            uint8 newRank = _rank(newCard);
            Direction dir = b.pendingDirection;

            bool isPush = newRank == oldRank;
            bool isCorrect = !isPush &&
                ((dir == Direction.HIGHER && newRank > oldRank) || (dir == Direction.LOWER && newRank < oldRank));

            b.currentCard = newCard;

            if (isPush) {
                ++b.pushCount;
                b.status = BetStatus.PLAYER_TURN;
                emit NextCardDealt(betId, b.requestId, b.user, newCard, false, true, b.currentMultiplierE18);
            } else if (isCorrect) {
                ++b.correctCount;
                uint256 factor = _multiplierFactorE18(dir, oldRank);
                uint256 newMult = (b.currentMultiplierE18 * factor) / ONE;
                if (newMult > maxMultiplierE18) newMult = maxMultiplierE18;
                b.currentMultiplierE18 = newMult;
                b.status = BetStatus.PLAYER_TURN;
                emit NextCardDealt(betId, b.requestId, b.user, newCard, true, false, newMult);
            } else {
                // Wrong guess — lose
                core.releaseReservation(b.collateral, b.reserved);
                b.reserved = 0;
                core.recordSettlement(b.collateral, b.amount, 0);
                core.payReferrer(b.user, b.collateral, b.amount);
                b.outcome = Outcome.WRONG_GUESS;
                b.status = BetStatus.RESOLVED;
                b.resolvedAt = block.timestamp;
                emit NextCardDealt(betId, b.requestId, b.user, newCard, false, false, 0);
                emit BetResolved(betId, b.user, Outcome.WRONG_GUESS, 0);
            }
        }
    }

    /* ========== MULTIPLIER ========== */

    /// @inheritdoc ICasinoHiLo
    function multiplierFactorE18(Direction direction, uint8 cardRank) external view override returns (uint256) {
        return _multiplierFactorE18(direction, cardRank);
    }

    /// @notice Per-correct-guess multiplier factor.
    /// Formula: factor = (12 - 13*HE) / countOfWinningRanks (in 1e18 precision)
    /// - HIGHER: count = 12 - rank (ranks rank+1..12)
    /// - LOWER: count = rank (ranks 0..rank-1)
    /// At edge ranks the opposite-direction guess is forbidden (count = 0)
    function _multiplierFactorE18(Direction direction, uint8 rank) internal view returns (uint256) {
        // numerator = 12*ONE - 13*houseEdge
        uint256 numerator = 12 * ONE - 13 * houseEdgeE18;
        uint8 count;
        if (direction == Direction.HIGHER) {
            if (rank >= RANKS_PER_DECK - 1) return 0;
            count = (RANKS_PER_DECK - 1) - rank;
        } else {
            if (rank == 0) return 0;
            count = rank;
        }
        return numerator / count;
    }

    function _rank(uint8 card) internal pure returns (uint8) {
        return card / 4;
    }

    /* ========== ADMIN ========== */

    function setHouseEdge(uint256 newHouseEdgeE18) external onlyRiskManager {
        if (newHouseEdgeE18 < MIN_HOUSE_EDGE_E18 || newHouseEdgeE18 > MAX_HOUSE_EDGE_E18) revert InvalidHouseEdge();
        houseEdgeE18 = newHouseEdgeE18;
    }

    function setMaxMultiplier(uint256 newMaxE18) external onlyRiskManager {
        if (newMaxE18 < 2e18) revert InvalidAmount();
        maxMultiplierE18 = newMaxE18;
    }

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
        returns (uint8 currentCard, uint256 currentMultiplierE18, uint8 guessCount, uint8 correctCount, uint8 pushCount)
    {
        Bet storage b = bets[betId];
        return (b.currentCard, b.currentMultiplierE18, b.guessCount, b.correctCount, b.pushCount);
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

    /* ========== MODIFIERS ========== */

    function _requireRole(ISportsAMMV2Manager.Role role) internal view {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, role)) revert InvalidSender();
    }

    modifier onlyRiskManager() {
        _requireRole(ISportsAMMV2Manager.Role.RISK_MANAGING);
        _;
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
