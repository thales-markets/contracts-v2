// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "chainlink-vrf/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import "chainlink-vrf/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// internal
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "@thales-dao/contracts/contracts/interfaces/IPriceFeed.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";

/// @title Blackjack
/// @author Overtime
/// @notice Single-player blackjack contract using Chainlink VRF for card dealing
/// @dev Supports USDC, WETH and OVER collateral, with bankroll reservation per collateral
contract Blackjack is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant USDC_UNIT = 1e6;
    uint private constant BLACKJACK_PAYOUT_NUMERATOR = 3;
    uint private constant BLACKJACK_PAYOUT_DENOMINATOR = 2;
    uint private constant MAX_CARDS = 11;

    /// @notice Highest legal hand total before busting
    uint8 private constant BLACKJACK_TARGET = 21;
    /// @notice Dealer stops drawing once total exceeds this (hits on soft 17 per house rules)
    uint8 private constant DEALER_STAND_THRESHOLD = 17;
    /// @notice Ace can count as 11 when it doesn't bust, else 1 — difference used for soft-ace reduction
    uint8 private constant ACE_HIGH_DELTA = 10;
    /// @notice Value of an Ace when counted high
    uint8 private constant ACE_HIGH_VALUE = 11;
    /// @notice Value of a face card (J/Q/K) and max non-ace pip
    uint8 private constant FACE_CARD_VALUE = 10;
    /// @notice Ace rank in the 1..13 encoding
    uint8 private constant ACE_RANK = 1;
    /// @notice Rank cutoff at which a card becomes a face card (J = 11, Q = 12, K = 13)
    uint8 private constant FACE_CARD_RANK_THRESHOLD = 11;
    /// @notice Number of distinct card ranks (Ace through King)
    uint8 private constant CARD_RANKS = 13;
    /// @notice Bit shift applied to a VRF word to derive a second card from the same word
    uint8 private constant CARD_DERIVATION_SHIFT = 128;

    /// @notice Minimum allowed bet value expressed in USD, normalized to 18 decimals
    uint public constant MIN_BET_USD = 3e18;

    /// @notice Minimum allowed cancel timeout in seconds
    uint public constant MIN_CANCEL_TIMEOUT = 30;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidCollateral();
    error InvalidAmount();
    error HandNotFound();
    error InvalidHandStatus();
    error HandNotOwner();
    error InsufficientAvailableLiquidity();

    /* ========== ENUMS ========== */

    /// @notice Lifecycle status of a blackjack hand
    enum HandStatus {
        NONE,
        AWAITING_DEAL,
        PLAYER_TURN,
        AWAITING_HIT,
        AWAITING_STAND,
        AWAITING_DOUBLE,
        RESOLVED,
        CANCELLED,
        AWAITING_SPLIT
    }

    /// @notice Outcome of a resolved blackjack hand
    enum HandResult {
        NONE,
        PLAYER_BLACKJACK,
        PLAYER_WIN,
        DEALER_WIN,
        PUSH,
        PLAYER_BUST,
        DEALER_BUST
    }

    /// @notice Type of action a VRF request is servicing
    enum VrfAction {
        NONE,
        DEAL,
        HIT,
        STAND,
        DOUBLE_DOWN,
        SPLIT
    }

    /* ========== STRUCTS ========== */

    /// @notice Stored data for an individual blackjack hand
    struct Hand {
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint requestId;
        uint placedAt;
        uint resolvedAt;
        uint reservedProfit;
        HandStatus status;
        HandResult result;
        bool isDoubledDown;
        uint8 playerCardCount;
        uint8 dealerCardCount;
        uint8[11] playerCards;
        uint8[11] dealerCards;
    }

    /// @notice Maps a VRF requestId to its hand and action context
    struct VrfRequest {
        uint handId;
        VrfAction action;
    }

    /// @notice Per-hand split state. Allocated only when a hand is split. Hand 1's data
    /// (cards, amount, result) stays on the parent Hand struct; this holds hand 2's state
    /// plus shared flags. `activeHand` is 1 while the player acts on hand 1, 2 once hand 1
    /// is final (stand/bust/double-resolved)
    struct SplitState {
        uint amount2;
        uint payout2;
        uint8 player2CardCount;
        uint8 activeHand;
        bool isAceSplit;
        bool isDoubled2;
        HandResult result2;
        uint8[11] player2Cards;
    }

    struct CoreAddresses {
        address owner;
        address manager;
        address priceFeed;
        address vrfCoordinator;
    }

    struct CollateralConfig {
        address usdc;
        address weth;
        address over;
        bytes32 wethPriceFeedKey;
        bytes32 overPriceFeedKey;
    }

    struct VrfConfig {
        uint256 subscriptionId;
        bytes32 keyHash;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
        bool nativePayment;
    }

    /* ========== STATE VARIABLES ========== */

    /// @notice Manager contract used for whitelist-based role checks
    ISportsAMMV2Manager public manager;

    /// @notice Price feed used for collateral normalization to USD
    IPriceFeed public priceFeed;

    /// @notice Chainlink VRF coordinator
    IVRFCoordinatorV2Plus public vrfCoordinator;

    /// @notice Supported collateral addresses
    address public usdc;
    address public weth;
    address public over;

    /// @notice Maximum allowed profit per hand in USD, normalized to 18 decimals
    uint public maxProfitUsd;

    /// @notice Timeout after which a pending hand can be cancelled
    uint public cancelTimeout;

    /// @notice Next hand id to assign
    uint public nextHandId;

    /// @notice Chainlink VRF v2.5 subscription id
    uint256 public subscriptionId;

    /// @notice Chainlink VRF key hash / gas lane
    bytes32 public keyHash;

    /// @notice Gas limit for VRF callback execution
    uint32 public callbackGasLimit;

    /// @notice Number of confirmations for VRF request
    uint16 public requestConfirmations;

    /// @notice Whether VRF request is paid in native token
    bool public nativePayment;

    /// @notice Whether a collateral is supported
    mapping(address => bool) public supportedCollateral;

    /// @notice Price feed key per collateral for non-USDC assets
    mapping(address => bytes32) public priceFeedKeyPerCollateral;

    /// @notice Stored hands by hand id
    mapping(uint => Hand) internal hands;

    /// @notice Maps VRF request id to its context
    mapping(uint => VrfRequest) public vrfRequests;

    /// @notice Tracks reserved house-side profit liability for all pending hands per collateral
    mapping(address => uint) public reservedProfitPerCollateral;

    /// @notice Hand IDs per user for history queries
    mapping(address => uint[]) private userHandIds;

    /// @notice Timestamp of last VRF request per hand (for cancel timeout)
    mapping(uint => uint) public lastRequestAt;

    /// @notice Free bets holder contract address
    address public freeBetsHolder;

    /// @notice Whether a hand was placed with a free bet
    mapping(uint => bool) public isFreeBet;

    /// @notice Referrals contract
    IReferrals public referrals;

    /// @notice Whether a hand has been split. Appended for upgrade safety
    mapping(uint => bool) public isSplit;

    /// @notice Per-hand split state, allocated only when `split()` is called
    mapping(uint => SplitState) internal splitStates;

    /* ========== PUBLIC / EXTERNAL METHODS ========== */

    /// @notice Initializes the blackjack contract
    function initialize(
        CoreAddresses calldata core,
        CollateralConfig calldata collateralConfig,
        uint _maxProfitUsd,
        uint _cancelTimeout,
        VrfConfig calldata vrfConfig
    ) external initializer {
        if (
            core.owner == address(0) ||
            core.manager == address(0) ||
            core.priceFeed == address(0) ||
            core.vrfCoordinator == address(0) ||
            collateralConfig.usdc == address(0) ||
            collateralConfig.weth == address(0) ||
            collateralConfig.over == address(0)
        ) {
            revert InvalidAddress();
        }

        if (_maxProfitUsd == 0) revert InvalidAmount();
        if (vrfConfig.callbackGasLimit == 0) revert InvalidAmount();

        setOwner(core.owner);
        initNonReentrant();

        manager = ISportsAMMV2Manager(core.manager);
        priceFeed = IPriceFeed(core.priceFeed);
        vrfCoordinator = IVRFCoordinatorV2Plus(core.vrfCoordinator);

        usdc = collateralConfig.usdc;
        weth = collateralConfig.weth;
        over = collateralConfig.over;

        supportedCollateral[collateralConfig.usdc] = true;
        supportedCollateral[collateralConfig.weth] = true;
        supportedCollateral[collateralConfig.over] = true;

        priceFeedKeyPerCollateral[collateralConfig.weth] = collateralConfig.wethPriceFeedKey;
        priceFeedKeyPerCollateral[collateralConfig.over] = collateralConfig.overPriceFeedKey;

        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        cancelTimeout = _cancelTimeout;

        subscriptionId = vrfConfig.subscriptionId;
        keyHash = vrfConfig.keyHash;
        callbackGasLimit = vrfConfig.callbackGasLimit;
        requestConfirmations = vrfConfig.requestConfirmations;
        nativePayment = vrfConfig.nativePayment;

        nextHandId = 1;
    }

    /// @notice Places a blackjack bet and requests initial deal from VRF
    /// @param collateral Collateral token address
    /// @param amount Amount of collateral to stake
    /// @return handId Newly created hand id
    /// @return requestId Chainlink VRF request id
    function placeBet(
        address collateral,
        uint amount,
        address _referrer
    ) external nonReentrant notPaused returns (uint handId, uint requestId) {
        _requireSupported(collateral);
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        if (_referrer != address(0) && address(referrals) != address(0)) {
            referrals.setReferrer(_referrer, msg.sender);
        }
        return _placeBet(msg.sender, collateral, amount, false);
    }

    /// @notice Places a blackjack bet using free bet balance
    function placeBetWithFreeBet(
        address collateral,
        uint amount
    ) external nonReentrant notPaused returns (uint handId, uint requestId) {
        _requireSupported(collateral);
        IFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, amount);
        return _placeBet(msg.sender, collateral, amount, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint amount,
        bool _isFreeBet
    ) internal returns (uint handId, uint requestId) {
        // `collateral` already validated by the external wrappers (placeBet / placeBetWithFreeBet)
        if (amount == 0) revert InvalidAmount();

        uint amountUsd = _getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        // Max profit is blackjack payout (3:2)
        uint potentialProfitCollateral = (amount * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR;
        uint potentialProfitUsd = _getUsdValue(collateral, potentialProfitCollateral);

        if (potentialProfitUsd > maxProfitUsd) revert InvalidAmount();

        _reserveOrRevert(collateral, potentialProfitCollateral);

        requestId = _requestRandomWords(2);

        handId = nextHandId++;
        Hand storage hand = hands[handId];
        hand.user = user;
        hand.collateral = collateral;
        hand.amount = amount;
        hand.placedAt = block.timestamp;
        hand.reservedProfit = potentialProfitCollateral;
        if (_isFreeBet) isFreeBet[handId] = true;
        _registerVrf(handId, hand, requestId, VrfAction.DEAL, HandStatus.AWAITING_DEAL);
        userHandIds[user].push(handId);

        emit HandCreated(handId, requestId, user, collateral, amount);
    }

    /// @notice Requests a hit (one additional card) for a player's hand
    /// @param handId Hand id to hit
    /// @return requestId Chainlink VRF request id
    function hit(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];

        _requireOwnedPlayerTurn(hand);

        requestId = _requestRandomWords(1);
        _registerVrf(handId, hand, requestId, VrfAction.HIT, HandStatus.AWAITING_HIT);
        emit HitRequested(handId, requestId, msg.sender);
    }

    /// @notice Player stands — dealer reveals hidden card and draws
    /// @param handId Hand id to stand on
    /// @return requestId Chainlink VRF request id
    function stand(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];

        _requireOwnedPlayerTurn(hand);

        // In split mode, stand on hand 1 just advances to hand 2 — no VRF, no dealer play yet.
        if (isSplit[handId] && splitStates[handId].activeHand == 1) {
            splitStates[handId].activeHand = 2;
            return 0;
        }

        requestId = _requestRandomWords(7);
        _registerVrf(handId, hand, requestId, VrfAction.STAND, HandStatus.AWAITING_STAND);
        emit StandRequested(handId, requestId, msg.sender);
    }

    /// @notice Player doubles down — doubles bet, receives one card, then dealer plays
    /// @param handId Hand id to double down on
    /// @return requestId Chainlink VRF request id
    function doubleDown(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];

        _requireOwnedPlayerTurn(hand);
        if (isFreeBet[handId]) revert InvalidHandStatus();

        bool isSpl = isSplit[handId];
        SplitState storage ss = splitStates[handId];

        // Ace-split hands are one-card-only — never reach PLAYER_TURN for hand 1/2 in that path,
        // so no explicit ace-split check needed here.
        uint activeCardCount;
        uint activeAmount;
        if (isSpl) {
            if (ss.activeHand == 1) {
                activeCardCount = hand.playerCardCount;
                activeAmount = hand.amount;
            } else {
                activeCardCount = ss.player2CardCount;
                activeAmount = ss.amount2;
            }
        } else {
            activeCardCount = hand.playerCardCount;
            activeAmount = hand.amount;
        }
        if (activeCardCount != 2) revert InvalidHandStatus();

        // Transfer matching stake for the doubled hand
        IERC20(hand.collateral).safeTransferFrom(msg.sender, address(this), activeAmount);

        // Reservation bump: doubling a hand increases its max profit from 1x to 2x of the ORIGINAL
        // per-hand stake → delta = activeAmount (the pre-double stake of that hand)
        _reserveOrRevert(hand.collateral, activeAmount);
        hand.reservedProfit += activeAmount;

        if (isSpl) {
            if (ss.activeHand == 1) {
                hand.amount = activeAmount * 2;
                hand.isDoubledDown = true;
                requestId = _requestRandomWords(1); // just the doubled card, no dealer yet
            } else {
                ss.amount2 = activeAmount * 2;
                ss.isDoubled2 = true;
                requestId = _requestRandomWords(7); // card + dealer
            }
        } else {
            hand.amount = activeAmount * 2;
            hand.isDoubledDown = true;
            requestId = _requestRandomWords(7);
        }

        _registerVrf(handId, hand, requestId, VrfAction.DOUBLE_DOWN, HandStatus.AWAITING_DOUBLE);
        emit DoubleDownRequested(handId, requestId, msg.sender, activeAmount);
    }

    /// @notice Splits a starting pair into two hands. User puts up an additional stake equal to
    /// the original. Each hand then plays independently (hit/stand/double). Aces split one card
    /// each and auto-resolve in the same VRF fulfillment (bundled 9-word request)
    /// @param handId Hand id to split
    /// @return requestId Chainlink VRF request id
    function split(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];
        _requireOwnedPlayerTurn(hand);
        if (hand.playerCardCount != 2) revert InvalidHandStatus();
        if (isSplit[handId]) revert InvalidHandStatus();
        if (isFreeBet[handId]) revert InvalidHandStatus();
        if (_cardValue(hand.playerCards[0]) != _cardValue(hand.playerCards[1])) revert InvalidHandStatus();

        // Pull matching stake for hand 2
        IERC20(hand.collateral).safeTransferFrom(msg.sender, address(this), hand.amount);

        // Update reservation: BJ payout no longer possible, each hand can win 1x.
        // newReservation = 2 * hand.amount (assuming no doubles yet)
        uint newReservedProfit = hand.amount * 2;
        uint oldReservedProfit = hand.reservedProfit;
        if (newReservedProfit > oldReservedProfit) {
            _reserveOrRevert(hand.collateral, newReservedProfit - oldReservedProfit);
        } else {
            reservedProfitPerCollateral[hand.collateral] -= (oldReservedProfit - newReservedProfit);
        }
        hand.reservedProfit = newReservedProfit;

        // Allocate split state
        bool aceSplit = hand.playerCards[0] == ACE_RANK;
        SplitState storage ss = splitStates[handId];
        ss.amount2 = hand.amount;
        ss.activeHand = 1;
        ss.isAceSplit = aceSplit;
        ss.player2Cards[0] = hand.playerCards[1];
        ss.player2CardCount = 1;
        // Clear hand 1's second card slot, reduce count to 1
        hand.playerCards[1] = 0;
        hand.playerCardCount = 1;
        isSplit[handId] = true;

        // 2 words for normal split (one second card per hand).
        // 9 words for ace split: 2 player cards + 1 dealer hidden + 6 dealer draws (auto-resolve).
        uint32 numWords = aceSplit ? 9 : 2;
        requestId = _requestRandomWords(numWords);

        _registerVrf(handId, hand, requestId, VrfAction.SPLIT, HandStatus.AWAITING_SPLIT);
        emit HandSplit(handId, requestId, msg.sender, hand.amount, aceSplit);
    }

    /// @notice Cancels a hand awaiting VRF response after timeout and refunds the stake
    /// @param handId Hand id to cancel
    function cancelHand(uint handId) external nonReentrant {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (hand.user != msg.sender) revert HandNotOwner();
        _requireCancellable(hand.status, false);
        if (block.timestamp < lastRequestAt[handId] + cancelTimeout) revert InvalidHandStatus();

        _cancelHand(handId, false);
    }

    /// @notice Emergency cancels a pending hand and refunds the stake
    /// @param handId Hand id to cancel
    function adminCancelHand(uint handId) external onlyResolver nonReentrant {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        _requireCancellable(hand.status, true);

        _cancelHand(handId, true);
    }

    /// @notice Pauses or unpauses the contract
    /// @param _paused True to pause, false to unpause
    function setPausedByRole(bool _paused) external onlyPauser {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                lastPauseTime = block.timestamp;
            }
            emit PauseChanged(_paused);
        }
    }

    /// @notice Coordinator-only VRF entrypoint
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert InvalidSender();
        _fulfillRandomWords(requestId, randomWords);
    }

    /* ========== INTERNAL / PRIVATE ========== */

    /// @notice Routes VRF fulfillment to the appropriate handler
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal {
        VrfRequest storage req = vrfRequests[requestId];
        uint handId = req.handId;
        if (handId == 0) return;

        Hand storage hand = hands[handId];

        if (req.action == VrfAction.DEAL) {
            _handleDeal(handId, hand, randomWords);
        } else if (req.action == VrfAction.HIT) {
            _handleHit(handId, hand, randomWords);
        } else if (req.action == VrfAction.STAND) {
            _handleStand(handId, hand, randomWords);
        } else if (req.action == VrfAction.DOUBLE_DOWN) {
            _handleDoubleDown(handId, hand, randomWords);
        } else if (req.action == VrfAction.SPLIT) {
            _handleSplit(handId, hand, randomWords);
        }
    }

    /// @notice Handles initial card deal after VRF fulfillment
    function _handleDeal(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_DEAL) return;

        // Derive 4 cards from 2 random words
        uint8 playerCard1 = _deriveCard(randomWords[0], 0);
        uint8 playerCard2 = _deriveCard(randomWords[1], 0);
        uint8 dealerFaceUp = _deriveCard(randomWords[0], 1);
        uint8 dealerHidden = _deriveCard(randomWords[1], 1);

        hand.playerCards[0] = playerCard1;
        hand.playerCards[1] = playerCard2;
        hand.playerCardCount = 2;
        hand.dealerCards[0] = dealerFaceUp;
        hand.dealerCardCount = 1;

        emit CardsDealt(handId, hand.user, playerCard1, playerCard2, dealerFaceUp);

        // Check for player natural blackjack
        bool playerBJ = _isBlackjack(playerCard1, playerCard2);

        if (playerBJ) {
            // Reveal dealer hidden card to check for push
            hand.dealerCards[1] = dealerHidden;
            hand.dealerCardCount = 2;
            _resolveHand(
                handId,
                hand,
                _isBlackjack(dealerFaceUp, dealerHidden) ? HandResult.PUSH : HandResult.PLAYER_BLACKJACK
            );
        } else {
            hand.status = HandStatus.PLAYER_TURN;
        }
    }

    /// @notice Handles a hit card after VRF fulfillment
    function _handleHit(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_HIT) return;

        uint8 newCard = _deriveCard(randomWords[0], 0);
        bool isSpl = isSplit[handId];
        SplitState storage ss = splitStates[handId];

        if (isSpl) {
            uint8 playerValue;
            if (ss.activeHand == 1) {
                hand.playerCards[hand.playerCardCount] = newCard;
                ++hand.playerCardCount;
                (playerValue, ) = _handValue(hand.playerCards, hand.playerCardCount);
                emit PlayerCardDealt(handId, hand.user, newCard, playerValue);

                // Hand 1 is "done" at >= 21 — advance to hand 2 (bust loses, 21 auto-stands)
                if (playerValue >= BLACKJACK_TARGET) {
                    ss.activeHand = 2;
                }
                hand.status = HandStatus.PLAYER_TURN;
            } else {
                ss.player2Cards[ss.player2CardCount] = newCard;
                ++ss.player2CardCount;
                (playerValue, ) = _handValue(ss.player2Cards, ss.player2CardCount);
                emit PlayerCardDealt(handId, hand.user, newCard, playerValue);

                if (playerValue >= BLACKJACK_TARGET) {
                    // Hand 2 done (bust or 21). If BOTH hands busted → resolve (no dealer needed).
                    // Otherwise dealer plays.
                    (uint8 hand1Value, ) = _handValue(hand.playerCards, hand.playerCardCount);
                    if (hand1Value > BLACKJACK_TARGET && playerValue > BLACKJACK_TARGET) {
                        _resolveSplit(handId, hand);
                    } else {
                        uint newRequestId = _requestRandomWords(7);
                        _registerVrf(handId, hand, newRequestId, VrfAction.STAND, HandStatus.AWAITING_STAND);
                        emit StandRequested(handId, newRequestId, hand.user);
                    }
                } else {
                    hand.status = HandStatus.PLAYER_TURN;
                }
            }
        } else {
            hand.playerCards[hand.playerCardCount] = newCard;
            ++hand.playerCardCount;
            (uint8 playerValue, ) = _handValue(hand.playerCards, hand.playerCardCount);
            emit PlayerCardDealt(handId, hand.user, newCard, playerValue);

            if (playerValue > BLACKJACK_TARGET) {
                _resolveHand(handId, hand, HandResult.PLAYER_BUST);
            } else if (playerValue == BLACKJACK_TARGET) {
                // Auto-stand at 21 — trigger dealer VRF in the same callback
                uint newRequestId = _requestRandomWords(7);
                _registerVrf(handId, hand, newRequestId, VrfAction.STAND, HandStatus.AWAITING_STAND);
                emit StandRequested(handId, newRequestId, hand.user);
            } else {
                hand.status = HandStatus.PLAYER_TURN;
            }
        }
    }

    /// @notice Handles stand — dealer reveals and draws, then resolves
    function _handleStand(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_STAND) return;

        uint n = randomWords.length;
        uint256[] memory mem = new uint256[](n);
        for (uint i; i < n; ++i) mem[i] = randomWords[i];
        _dealerPlayAndResolveFromMemory(handId, hand, mem);
    }

    /// @notice Handles double down — one player card, then dealer plays
    function _handleDoubleDown(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_DOUBLE) return;

        uint8 newCard = _deriveCard(randomWords[0], 0);
        bool isSpl = isSplit[handId];
        SplitState storage ss = splitStates[handId];

        if (isSpl && ss.activeHand == 1) {
            // Split + double on hand 1: 1 VRF word, deal card, advance to hand 2 regardless of bust.
            hand.playerCards[hand.playerCardCount] = newCard;
            ++hand.playerCardCount;
            (uint8 p1Value, ) = _handValue(hand.playerCards, hand.playerCardCount);
            emit PlayerCardDealt(handId, hand.user, newCard, p1Value);

            ss.activeHand = 2;
            hand.status = HandStatus.PLAYER_TURN;
            return;
        }

        // Non-split, or split + double on hand 2 (7 VRF words).
        uint8 playerValue;
        if (isSpl) {
            ss.player2Cards[ss.player2CardCount] = newCard;
            ++ss.player2CardCount;
            (playerValue, ) = _handValue(ss.player2Cards, ss.player2CardCount);
        } else {
            hand.playerCards[hand.playerCardCount] = newCard;
            ++hand.playerCardCount;
            (playerValue, ) = _handValue(hand.playerCards, hand.playerCardCount);
        }
        emit PlayerCardDealt(handId, hand.user, newCard, playerValue);

        if (!isSpl && playerValue > BLACKJACK_TARGET) {
            _resolveHand(handId, hand, HandResult.PLAYER_BUST);
            return;
        }

        if (isSpl && playerValue > BLACKJACK_TARGET) {
            // Hand 2 busted via double. If hand 1 also busted, skip dealer.
            (uint8 p1Value, ) = _handValue(hand.playerCards, hand.playerCardCount);
            if (p1Value > BLACKJACK_TARGET) {
                _resolveSplit(handId, hand);
                return;
            }
        }

        // Dealer plays using randomWords[1..6]
        uint256[] memory dealerWords = new uint256[](6);
        for (uint i; i < 6; ++i) {
            dealerWords[i] = randomWords[i + 1];
        }
        _dealerPlayAndResolveFromMemory(handId, hand, dealerWords);
    }

    /// @notice Handles split fulfillment. Deals a second card to each split hand. For ace-split,
    /// bundles dealer play + resolution into the same fulfillment (one-card rule means the player
    /// has no remaining decisions, so front-running isn't possible)
    function _handleSplit(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_SPLIT) return;

        SplitState storage ss = splitStates[handId];

        // Deal second card to hand 1 and hand 2
        uint8 hand1Card2 = _deriveCard(randomWords[0], 0);
        uint8 hand2Card2 = _deriveCard(randomWords[1], 0);
        hand.playerCards[hand.playerCardCount] = hand1Card2;
        ++hand.playerCardCount;
        ss.player2Cards[ss.player2CardCount] = hand2Card2;
        ++ss.player2CardCount;

        if (ss.isAceSplit) {
            // One-card rule: both hands are final. Play dealer using words 2..8 (7 words).
            uint256[] memory dealerWords = new uint256[](7);
            for (uint i; i < 7; ++i) {
                dealerWords[i] = randomWords[i + 2];
            }
            _dealerPlayAndResolveFromMemory(handId, hand, dealerWords);
        } else {
            hand.status = HandStatus.PLAYER_TURN;
        }
    }

    /// @notice Reveals dealer hidden card, draws to 17+, then resolves (both single-hand and split)
    function _dealerPlayAndResolveFromMemory(uint handId, Hand storage hand, uint256[] memory randomWords) internal {
        // Reveal dealer hidden card
        uint8 hiddenCard = _deriveCard(randomWords[0], 0);
        hand.dealerCards[hand.dealerCardCount] = hiddenCard;
        ++hand.dealerCardCount;

        // Dealer draws until hard 17+ (hits on soft 17)
        uint wordIdx = 1;
        while (wordIdx < randomWords.length && hand.dealerCardCount < MAX_CARDS) {
            (uint8 dealerValue, bool dealerSoft) = _handValue(hand.dealerCards, hand.dealerCardCount);
            if (dealerValue > DEALER_STAND_THRESHOLD) break;
            if (dealerValue == DEALER_STAND_THRESHOLD && !dealerSoft) break;

            uint8 card = _deriveCard(randomWords[wordIdx], 0);
            hand.dealerCards[hand.dealerCardCount] = card;
            ++hand.dealerCardCount;
            ++wordIdx;
        }

        if (isSplit[handId]) {
            _resolveSplit(handId, hand);
            return;
        }

        (uint8 dv, ) = _handValue(hand.dealerCards, hand.dealerCardCount);
        (uint8 pv, ) = _handValue(hand.playerCards, hand.playerCardCount);
        if (dv > BLACKJACK_TARGET) {
            _resolveHand(handId, hand, HandResult.DEALER_BUST);
        } else if (pv > dv) {
            _resolveHand(handId, hand, HandResult.PLAYER_WIN);
        } else if (pv == dv) {
            _resolveHand(handId, hand, HandResult.PUSH);
        } else {
            _resolveHand(handId, hand, HandResult.DEALER_WIN);
        }
    }

    /// @notice Judges a split hand's result against the dealer (no blackjack payout path)
    function _judgeSplit(uint8 pv, uint8 dv, bool dBust) internal pure returns (HandResult r) {
        if (pv > BLACKJACK_TARGET) r = HandResult.PLAYER_BUST;
        else if (dBust) r = HandResult.DEALER_BUST;
        else if (pv > dv) r = HandResult.PLAYER_WIN;
        else if (pv == dv) r = HandResult.PUSH;
        else r = HandResult.DEALER_WIN;
    }

    /// @notice Returns payout for a split-hand result. No 3:2 BJ payout even on 21 (A+10 post-split)
    function _splitPayout(uint stake, HandResult r) internal pure returns (uint payout) {
        if (r == HandResult.PLAYER_WIN || r == HandResult.DEALER_BUST) payout = stake * 2;
        else if (r == HandResult.PUSH) payout = stake;
        // default 0
    }

    /// @notice Resolves both split hands against the dealer; single payout transfer, single
    /// referrer payment on total loss. Also used for the both-busted path where dealer never
    /// played — PLAYER_BUST short-circuits in `_judgeSplit` before any dealer comparison
    function _resolveSplit(uint handId, Hand storage hand) internal {
        reservedProfitPerCollateral[hand.collateral] -= hand.reservedProfit;
        SplitState storage ss = splitStates[handId];

        (uint8 dealerValue, ) = _handValue(hand.dealerCards, hand.dealerCardCount);
        bool dealerBust = dealerValue > BLACKJACK_TARGET;
        (uint8 p1v, ) = _handValue(hand.playerCards, hand.playerCardCount);
        (uint8 p2v, ) = _handValue(ss.player2Cards, ss.player2CardCount);
        HandResult r1 = _judgeSplit(p1v, dealerValue, dealerBust);
        HandResult r2 = _judgeSplit(p2v, dealerValue, dealerBust);
        uint payout1 = _splitPayout(hand.amount, r1);
        uint payout2 = _splitPayout(ss.amount2, r2);
        uint totalPayout = payout1 + payout2;

        if (totalPayout > 0) {
            IERC20(hand.collateral).safeTransfer(hand.user, totalPayout);
        } else {
            _payReferrer(hand.user, hand.collateral, hand.amount + ss.amount2);
        }

        hand.result = r1;
        hand.payout = totalPayout;
        ss.result2 = r2;
        ss.payout2 = payout2;
        hand.status = HandStatus.RESOLVED;
        hand.resolvedAt = block.timestamp;

        emit HandResolved(handId, hand.requestId, hand.user, r1, totalPayout);
    }

    /// @notice Resolves a hand with payout based on result
    function _resolveHand(uint handId, Hand storage hand, HandResult _result) internal {
        reservedProfitPerCollateral[hand.collateral] -= hand.reservedProfit;

        uint payout;
        if (_result == HandResult.PLAYER_BLACKJACK) {
            payout = hand.amount + (hand.amount * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR;
        } else if (_result == HandResult.PLAYER_WIN || _result == HandResult.DEALER_BUST) {
            payout = hand.amount * 2;
        } else if (_result == HandResult.PUSH) {
            payout = hand.amount;
        }

        if (payout > 0) {
            if (isFreeBet[handId]) {
                IERC20(hand.collateral).safeTransfer(freeBetsHolder, payout);
                IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(hand.user, hand.collateral, payout, hand.amount);
            } else {
                IERC20(hand.collateral).safeTransfer(hand.user, payout);
            }
        }

        if (payout == 0) {
            _payReferrer(hand.user, hand.collateral, hand.amount);
        }

        hand.payout = payout;
        hand.result = _result;
        hand.status = HandStatus.RESOLVED;
        hand.resolvedAt = block.timestamp;

        emit HandResolved(handId, hand.requestId, hand.user, _result, payout);
    }

    function _payReferrer(address _user, address _collateral, uint _amount) internal {
        if (address(referrals) == address(0)) return;
        address referrer = referrals.referrals(_user);
        if (referrer == address(0)) return;
        uint referrerFee = referrals.getReferrerFee(referrer);
        if (referrerFee == 0) return;
        uint referrerAmount = (_amount * referrerFee) / ONE;
        if (referrerAmount > 0) {
            IERC20(_collateral).safeTransfer(referrer, referrerAmount);
            emit ReferrerPaid(referrer, _user, referrerAmount, _amount, _collateral);
        }
    }

    function _cancelHand(uint handId, bool adminCancelled) internal {
        Hand storage hand = hands[handId];

        reservedProfitPerCollateral[hand.collateral] -= hand.reservedProfit;

        hand.status = HandStatus.CANCELLED;
        hand.resolvedAt = block.timestamp;

        // Aggregate refund includes both legs if the hand was split. Free-bet splits are blocked
        // at `split()`, so the free-bet branch can only see a non-split hand (user never added funds)
        uint refund = hand.amount;
        if (isSplit[handId]) {
            refund += splitStates[handId].amount2;
        }

        if (isFreeBet[handId]) {
            hand.payout = 0;
            IERC20(hand.collateral).safeTransfer(freeBetsHolder, hand.amount);
            IFreeBetsHolder(freeBetsHolder).confirmCasinoBetResolved(hand.user, hand.collateral, hand.amount, hand.amount);
        } else {
            hand.payout = refund;
            IERC20(hand.collateral).safeTransfer(hand.user, refund);
        }

        emit HandCancelled(handId, hand.requestId, hand.user, refund, adminCancelled);
    }

    /// @notice Sets VRF request context on a hand and records the request mapping
    function _registerVrf(uint handId, Hand storage hand, uint requestId, VrfAction action, HandStatus status) internal {
        hand.status = status;
        hand.requestId = requestId;
        lastRequestAt[handId] = block.timestamp;
        vrfRequests[requestId] = VrfRequest({handId: handId, action: action});
    }

    /// @notice Reverts with `InvalidCollateral` if the collateral isn't supported
    function _requireSupported(address collateral) internal view {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
    }

    /// @notice Asserts the hand exists, is owned by msg.sender, and is currently the player's turn.
    /// Mirrors the 3-check guard used by hit/stand/doubleDown/split
    function _requireOwnedPlayerTurn(Hand storage hand) internal view {
        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (hand.user != msg.sender) revert HandNotOwner();
        if (hand.status != HandStatus.PLAYER_TURN) revert InvalidHandStatus();
    }

    /// @notice Reverts unless the status is one the cancel path supports. Admin path additionally
    /// accepts PLAYER_TURN so stuck hands between VRF responses can be cleared
    function _requireCancellable(HandStatus s, bool allowPlayerTurn) internal pure {
        if (
            s != HandStatus.AWAITING_DEAL &&
            s != HandStatus.AWAITING_HIT &&
            s != HandStatus.AWAITING_STAND &&
            s != HandStatus.AWAITING_DOUBLE &&
            s != HandStatus.AWAITING_SPLIT &&
            (!allowPlayerTurn || s != HandStatus.PLAYER_TURN)
        ) revert InvalidHandStatus();
    }

    /// @notice Bumps per-collateral reservation by `delta` and reverts with rollback if bankroll insufficient
    function _reserveOrRevert(address collateral, uint delta) internal {
        reservedProfitPerCollateral[collateral] += delta;
        if (IERC20(collateral).balanceOf(address(this)) < reservedProfitPerCollateral[collateral]) {
            reservedProfitPerCollateral[collateral] -= delta;
            revert InsufficientAvailableLiquidity();
        }
    }

    /// @notice Requests random words from Chainlink VRF
    function _requestRandomWords(uint32 numWords) internal returns (uint requestId) {
        requestId = vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
    }

    /// @notice Derives a card rank (1-13) from a random word using a shift index
    /// @param word Random word from VRF
    /// @param shiftIndex 0 or 1 to derive different cards from the same word
    /// @return Card rank 1-13 (1=Ace, 2-10, 11=J, 12=Q, 13=K)
    function _deriveCard(uint256 word, uint8 shiftIndex) internal pure returns (uint8) {
        return uint8(((word >> (shiftIndex * CARD_DERIVATION_SHIFT)) % CARD_RANKS) + 1);
    }

    /// @notice Returns the card value for blackjack
    /// @param rank Card rank 1-13
    /// @return Card value (Ace=11, 2-10=face, J/Q/K=10)
    function _cardValue(uint8 rank) internal pure returns (uint8) {
        if (rank == ACE_RANK) return ACE_HIGH_VALUE;
        if (rank >= FACE_CARD_RANK_THRESHOLD) return FACE_CARD_VALUE;
        return rank;
    }

    /// @notice Best hand value (<=21 where possible) plus whether an Ace is still counted as 11
    function _handValue(uint8[11] storage cards, uint8 count) internal view returns (uint8 total, bool soft) {
        uint8 aces;
        for (uint8 i; i < count; ++i) {
            total += _cardValue(cards[i]);
            if (cards[i] == ACE_RANK) ++aces;
        }
        while (total > BLACKJACK_TARGET && aces > 0) {
            total -= ACE_HIGH_DELTA;
            --aces;
        }
        soft = aces > 0;
    }

    /// @notice Returns whether two cards form a natural blackjack
    function _isBlackjack(uint8 card1, uint8 card2) internal pure returns (bool) {
        return _cardValue(card1) + _cardValue(card2) == BLACKJACK_TARGET;
    }

    /// @notice Returns the normalized price for a supported collateral
    function _getCollateralPrice(address collateral) internal view returns (uint) {
        _requireSupported(collateral);

        if (collateral == usdc) {
            return ONE;
        }

        bytes32 currencyKey = priceFeedKeyPerCollateral[collateral];
        if (currencyKey == bytes32(0)) revert InvalidCollateral();

        uint price = priceFeed.rateForCurrency(currencyKey);
        if (price == 0) revert InvalidCollateral();

        return price;
    }

    /// @notice Converts collateral amount into USD value normalized to 18 decimals
    function _getUsdValue(address collateral, uint amount) internal view returns (uint) {
        if (collateral == usdc) {
            return (amount * ONE) / USDC_UNIT;
        }

        uint price = _getCollateralPrice(collateral);
        return (amount * price) / ONE;
    }

    /* ========== GETTERS ========== */

    /// @notice Returns core hand data
    function getHandBase(
        uint handId
    )
        external
        view
        returns (
            address user,
            address collateral,
            uint amount,
            uint payout,
            uint requestId,
            uint placedAt,
            uint resolvedAt,
            uint reservedProfit
        )
    {
        Hand storage h = hands[handId];
        return (h.user, h.collateral, h.amount, h.payout, h.requestId, h.placedAt, h.resolvedAt, h.reservedProfit);
    }

    /// @notice Returns hand status and result details
    function getHandDetails(
        uint handId
    )
        external
        view
        returns (HandStatus status, HandResult result, bool isDoubledDown, uint8 playerCardCount, uint8 dealerCardCount)
    {
        Hand storage h = hands[handId];
        return (h.status, h.result, h.isDoubledDown, h.playerCardCount, h.dealerCardCount);
    }

    /// @notice Returns the maximum potential payout for a bet amount (blackjack 3:2)
    function getMaxPayout(address, uint amount) external pure returns (uint) {
        return amount + (amount * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR;
    }

    /// @notice Returns normalized collateral price
    function getCollateralPrice(address collateral) external view returns (uint) {
        return _getCollateralPrice(collateral);
    }

    /// @notice Returns currently available liquidity for a collateral after reserved profit
    function getAvailableLiquidity(address collateral) external view returns (uint) {
        _requireSupported(collateral);
        uint balance = IERC20(collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[collateral];
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Returns the number of hands placed by a user
    function getUserHandCount(address user) external view returns (uint) {
        return userHandIds[user].length;
    }

    /// @notice Returns hand IDs for a user's hands with pagination (reverse chronological)
    function getUserHandIds(address user, uint offset, uint limit) external view returns (uint[] memory ids) {
        uint[] storage allIds = userHandIds[user];
        uint len = allIds.length;
        if (offset >= len) return new uint[](0);
        uint remaining = len - offset;
        uint count = remaining < limit ? remaining : limit;
        ids = new uint[](count);
        for (uint i; i < count; ++i) {
            ids[i] = allIds[len - 1 - offset - i];
        }
    }

    /// @notice Returns recent hand IDs with pagination (reverse chronological)
    function getRecentHandIds(uint offset, uint limit) external view returns (uint[] memory ids) {
        uint latest = nextHandId - 1;
        if (offset >= latest) return new uint[](0);
        uint start = latest - offset;
        uint count = start < limit ? start : limit;
        ids = new uint[](count);
        for (uint i; i < count; ++i) {
            ids[i] = start - i;
        }
    }

    /// @notice Returns player and dealer cards for a hand
    function getHandCards(uint handId) external view returns (uint8[] memory playerCards, uint8[] memory dealerCards) {
        Hand storage h = hands[handId];
        playerCards = new uint8[](h.playerCardCount);
        dealerCards = new uint8[](h.dealerCardCount);
        for (uint8 i; i < h.playerCardCount; ++i) playerCards[i] = h.playerCards[i];
        for (uint8 i; i < h.dealerCardCount; ++i) dealerCards[i] = h.dealerCards[i];
    }

    /// @notice Returns split state for a hand. Caller should first check `isSplit[handId]`
    function getSplitDetails(
        uint handId
    )
        external
        view
        returns (
            uint amount2,
            uint payout2,
            uint8 player2CardCount,
            uint8 activeHand,
            bool isAceSplit,
            bool isDoubled2,
            HandResult result2,
            uint8[] memory player2Cards
        )
    {
        SplitState storage s = splitStates[handId];
        player2Cards = new uint8[](s.player2CardCount);
        for (uint8 i; i < s.player2CardCount; ++i) player2Cards[i] = s.player2Cards[i];
        return (s.amount2, s.payout2, s.player2CardCount, s.activeHand, s.isAceSplit, s.isDoubled2, s.result2, player2Cards);
    }

    /* ========== SETTERS ========== */

    /// @notice Sets risk parameters. Pass zero to skip a field. `_cancelTimeout` below
    /// `MIN_CANCEL_TIMEOUT` is rejected (use 0 to leave it untouched)
    function setRiskParams(uint _maxProfitUsd, uint _cancelTimeout) external onlyRiskManager {
        if (_maxProfitUsd != 0) maxProfitUsd = _maxProfitUsd;
        if (_cancelTimeout != 0) {
            if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
            cancelTimeout = _cancelTimeout;
        }
        emit RiskParamsChanged(_maxProfitUsd, _cancelTimeout);
    }

    /// @notice Sets a collateral's support flag and price-feed key in one call. Both values are
    /// always written — pass the current values for any field you want to leave unchanged
    function setCollateralConfig(address collateral, bytes32 currencyKey, bool isSupported) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        supportedCollateral[collateral] = isSupported;
        priceFeedKeyPerCollateral[collateral] = currencyKey;
        emit CollateralConfigChanged(collateral, currencyKey, isSupported);
    }

    /// @notice Sets protocol addresses in one call. Pass address(0) for any slot you want to skip.
    /// Note: `freeBetsHolder` and `referrals` cannot be cleared via this path — use a dedicated
    /// re-deployment if you need to detach them
    function setAddresses(
        address _manager,
        address _priceFeed,
        address _vrfCoordinator,
        address _freeBetsHolder,
        address _referrals
    ) external onlyOwner {
        if (_manager != address(0)) manager = ISportsAMMV2Manager(_manager);
        if (_priceFeed != address(0)) priceFeed = IPriceFeed(_priceFeed);
        if (_vrfCoordinator != address(0)) vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        if (_freeBetsHolder != address(0)) freeBetsHolder = _freeBetsHolder;
        if (_referrals != address(0)) referrals = IReferrals(_referrals);
        emit AddressesChanged(_manager, _priceFeed, _vrfCoordinator, _freeBetsHolder, _referrals);
    }

    /// @notice Withdraws collateral from the contract bankroll
    function withdrawCollateral(address _collateral, address _recipient, uint _amount) external onlyOwner {
        uint balance = IERC20(_collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[_collateral];
        if (_amount > balance || balance - _amount < reserved) revert InsufficientAvailableLiquidity();
        address recipient = _recipient == address(0) ? owner : _recipient;
        IERC20(_collateral).safeTransfer(recipient, _amount);
        emit WithdrawnCollateral(_collateral, recipient, _amount);
    }

    /// @notice Sets Chainlink VRF configuration
    function setVrfConfig(
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations,
        bool _nativePayment
    ) external onlyOwner {
        if (_callbackGasLimit == 0) revert InvalidAmount();

        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
        nativePayment = _nativePayment;

        emit VrfConfigChanged(_subscriptionId, _keyHash, _callbackGasLimit, _requestConfirmations, _nativePayment);
    }

    /* ========== MODIFIERS ========== */

    function _requireRole(ISportsAMMV2Manager.Role role) internal view {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, role)) {
            revert InvalidSender();
        }
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

    /* ========== EVENTS ========== */

    event HandCreated(uint indexed handId, uint indexed requestId, address indexed user, address collateral, uint amount);

    event CardsDealt(uint indexed handId, address indexed user, uint8 playerCard1, uint8 playerCard2, uint8 dealerFaceUp);

    event HitRequested(uint indexed handId, uint indexed requestId, address indexed user);

    event PlayerCardDealt(uint indexed handId, address indexed user, uint8 card, uint8 handValue);

    event StandRequested(uint indexed handId, uint indexed requestId, address indexed user);

    event DoubleDownRequested(uint indexed handId, uint indexed requestId, address indexed user, uint additionalAmount);

    event HandSplit(
        uint indexed handId,
        uint indexed requestId,
        address indexed user,
        uint additionalAmount,
        bool isAceSplit
    );

    event HandResolved(uint indexed handId, uint indexed requestId, address indexed user, HandResult result, uint payout);

    event HandCancelled(
        uint indexed handId,
        uint indexed requestId,
        address indexed user,
        uint refundedAmount,
        bool adminCancelled
    );

    event RiskParamsChanged(uint maxProfitUsd, uint cancelTimeout);
    event AddressesChanged(
        address manager,
        address priceFeed,
        address vrfCoordinator,
        address freeBetsHolder,
        address referrals
    );
    event CollateralConfigChanged(address collateral, bytes32 currencyKey, bool supported);
    event ReferrerPaid(address indexed referrer, address indexed user, uint amount, uint betAmount, address collateral);
    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint amount);
    event VrfConfigChanged(
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        bool nativePayment
    );
}
