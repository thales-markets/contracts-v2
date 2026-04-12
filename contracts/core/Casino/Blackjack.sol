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
import "../../interfaces/ICasinoFreeBetsHolder.sol";
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

    /// @notice Minimum allowed bet value expressed in USD, normalized to 18 decimals
    uint public constant MIN_BET_USD = 3e18;

    /// @notice Minimum allowed cancel timeout in seconds
    uint public constant MIN_CANCEL_TIMEOUT = 30;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidCollateral();
    error InvalidPrice();
    error InvalidAmount();
    error HandNotFound();
    error InvalidHandStatus();
    error HandNotOwner();
    error CancelTimeoutNotReached();
    error MaxProfitExceeded();
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
        CANCELLED
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
        DOUBLE_DOWN
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
        if (vrfConfig.callbackGasLimit == 0 || vrfConfig.requestConfirmations == 0) revert InvalidAmount();

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
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        _setReferrer(_referrer, msg.sender);
        return _placeBet(msg.sender, collateral, amount, false);
    }

    /// @notice Places a blackjack bet using free bet balance
    function placeBetWithFreeBet(
        address collateral,
        uint amount
    ) external nonReentrant notPaused returns (uint handId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        ICasinoFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, amount);
        return _placeBet(msg.sender, collateral, amount, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint amount,
        bool _isFreeBet
    ) internal returns (uint handId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        if (amount == 0) revert InvalidAmount();

        uint amountUsd = _getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        // Max profit is blackjack payout (3:2)
        uint potentialProfitCollateral = (amount * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR;
        uint potentialProfitUsd = _getUsdValue(collateral, potentialProfitCollateral);

        if (potentialProfitUsd > maxProfitUsd) revert MaxProfitExceeded();

        reservedProfitPerCollateral[collateral] += potentialProfitCollateral;

        if (!_hasEnoughLiquidity(collateral)) {
            reservedProfitPerCollateral[collateral] -= potentialProfitCollateral;
            revert InsufficientAvailableLiquidity();
        }

        requestId = _requestRandomWords(2);

        handId = nextHandId++;
        Hand storage hand = hands[handId];
        hand.user = user;
        hand.collateral = collateral;
        hand.amount = amount;
        hand.requestId = requestId;
        hand.placedAt = block.timestamp;
        lastRequestAt[handId] = block.timestamp;
        hand.reservedProfit = potentialProfitCollateral;
        hand.status = HandStatus.AWAITING_DEAL;

        if (_isFreeBet) isFreeBet[handId] = true;

        vrfRequests[requestId] = VrfRequest({handId: handId, action: VrfAction.DEAL});
        userHandIds[user].push(handId);

        emit HandCreated(handId, requestId, user, collateral, amount);
    }

    /// @notice Requests a hit (one additional card) for a player's hand
    /// @param handId Hand id to hit
    /// @return requestId Chainlink VRF request id
    function hit(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (hand.user != msg.sender) revert HandNotOwner();
        if (hand.status != HandStatus.PLAYER_TURN) revert InvalidHandStatus();

        requestId = _requestRandomWords(1);

        hand.status = HandStatus.AWAITING_HIT;
        hand.requestId = requestId;
        lastRequestAt[handId] = block.timestamp;

        vrfRequests[requestId] = VrfRequest({handId: handId, action: VrfAction.HIT});

        emit HitRequested(handId, requestId, msg.sender);
    }

    /// @notice Player stands — dealer reveals hidden card and draws
    /// @param handId Hand id to stand on
    /// @return requestId Chainlink VRF request id
    function stand(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (hand.user != msg.sender) revert HandNotOwner();
        if (hand.status != HandStatus.PLAYER_TURN) revert InvalidHandStatus();

        requestId = _requestRandomWords(7);

        hand.status = HandStatus.AWAITING_STAND;
        hand.requestId = requestId;
        lastRequestAt[handId] = block.timestamp;

        vrfRequests[requestId] = VrfRequest({handId: handId, action: VrfAction.STAND});

        emit StandRequested(handId, requestId, msg.sender);
    }

    /// @notice Player doubles down — doubles bet, receives one card, then dealer plays
    /// @param handId Hand id to double down on
    /// @return requestId Chainlink VRF request id
    function doubleDown(uint handId) external nonReentrant notPaused returns (uint requestId) {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (hand.user != msg.sender) revert HandNotOwner();
        if (hand.status != HandStatus.PLAYER_TURN) revert InvalidHandStatus();
        if (hand.playerCardCount != 2) revert InvalidHandStatus();
        if (isFreeBet[handId]) revert InvalidHandStatus();

        // Transfer additional bet amount
        IERC20(hand.collateral).safeTransferFrom(msg.sender, address(this), hand.amount);

        // Update reservation: doubled bet can win at most 1:1 (no blackjack after double)
        // New max profit = doubled amount * 1 = 2 * original amount
        uint newReservedProfit = hand.amount * 2;
        uint oldReservedProfit = hand.reservedProfit;

        if (newReservedProfit > oldReservedProfit) {
            reservedProfitPerCollateral[hand.collateral] += (newReservedProfit - oldReservedProfit);
            if (!_hasEnoughLiquidity(hand.collateral)) {
                reservedProfitPerCollateral[hand.collateral] -= (newReservedProfit - oldReservedProfit);
                revert InsufficientAvailableLiquidity();
            }
        } else {
            reservedProfitPerCollateral[hand.collateral] -= (oldReservedProfit - newReservedProfit);
        }

        hand.amount = hand.amount * 2;
        hand.reservedProfit = newReservedProfit;
        hand.isDoubledDown = true;

        requestId = _requestRandomWords(7);

        hand.status = HandStatus.AWAITING_DOUBLE;
        hand.requestId = requestId;
        lastRequestAt[handId] = block.timestamp;

        vrfRequests[requestId] = VrfRequest({handId: handId, action: VrfAction.DOUBLE_DOWN});

        emit DoubleDownRequested(handId, requestId, msg.sender, hand.amount / 2);
    }

    /// @notice Cancels a hand awaiting VRF response after timeout and refunds the stake
    /// @param handId Hand id to cancel
    function cancelHand(uint handId) external nonReentrant {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (hand.user != msg.sender) revert HandNotOwner();
        if (
            hand.status != HandStatus.AWAITING_DEAL &&
            hand.status != HandStatus.AWAITING_HIT &&
            hand.status != HandStatus.AWAITING_STAND &&
            hand.status != HandStatus.AWAITING_DOUBLE
        ) revert InvalidHandStatus();
        if (block.timestamp < lastRequestAt[handId] + cancelTimeout) revert CancelTimeoutNotReached();

        _cancelHand(handId, false);
    }

    /// @notice Emergency cancels a pending hand and refunds the stake
    /// @param handId Hand id to cancel
    function adminCancelHand(uint handId) external onlyResolver nonReentrant {
        Hand storage hand = hands[handId];

        if (hand.status == HandStatus.NONE) revert HandNotFound();
        if (
            hand.status != HandStatus.AWAITING_DEAL &&
            hand.status != HandStatus.PLAYER_TURN &&
            hand.status != HandStatus.AWAITING_HIT &&
            hand.status != HandStatus.AWAITING_STAND &&
            hand.status != HandStatus.AWAITING_DOUBLE
        ) revert InvalidHandStatus();

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

            bool dealerBJ = _isBlackjack(dealerFaceUp, dealerHidden);

            if (dealerBJ) {
                _resolveHand(handId, hand, HandResult.PUSH);
            } else {
                _resolveHand(handId, hand, HandResult.PLAYER_BLACKJACK);
            }
        } else {
            hand.status = HandStatus.PLAYER_TURN;
        }
    }

    /// @notice Handles a hit card after VRF fulfillment
    function _handleHit(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_HIT) return;

        uint8 newCard = _deriveCard(randomWords[0], 0);
        hand.playerCards[hand.playerCardCount] = newCard;
        hand.playerCardCount++;

        uint8 playerValue = _calculateHandValue(hand.playerCards, hand.playerCardCount);

        emit PlayerCardDealt(handId, hand.user, newCard, playerValue);

        if (playerValue > 21) {
            _resolveHand(handId, hand, HandResult.PLAYER_BUST);
        } else {
            hand.status = HandStatus.PLAYER_TURN;
        }
    }

    /// @notice Handles stand — dealer reveals and draws, then resolves
    function _handleStand(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_STAND) return;

        _dealerPlayAndResolve(handId, hand, randomWords);
    }

    /// @notice Handles double down — one player card, then dealer plays
    function _handleDoubleDown(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        if (hand.status != HandStatus.AWAITING_DOUBLE) return;

        // Deal one card to player
        uint8 newCard = _deriveCard(randomWords[0], 0);
        hand.playerCards[hand.playerCardCount] = newCard;
        hand.playerCardCount++;

        uint8 playerValue = _calculateHandValue(hand.playerCards, hand.playerCardCount);

        emit PlayerCardDealt(handId, hand.user, newCard, playerValue);

        if (playerValue > 21) {
            _resolveHand(handId, hand, HandResult.PLAYER_BUST);
        } else {
            // Dealer plays using randomWords[1..6]
            uint256[] memory dealerWords = new uint256[](6);
            for (uint i = 0; i < 6; i++) {
                dealerWords[i] = randomWords[i + 1];
            }
            _dealerPlayAndResolveFromMemory(handId, hand, dealerWords);
        }
    }

    /// @notice Dealer reveals hidden card, draws to 17+, and resolves the hand
    function _dealerPlayAndResolve(uint handId, Hand storage hand, uint256[] calldata randomWords) internal {
        // Reveal dealer hidden card
        uint8 hiddenCard = _deriveCard(randomWords[0], 0);
        hand.dealerCards[hand.dealerCardCount] = hiddenCard;
        hand.dealerCardCount++;

        // Dealer draws until hard 17+ (hits on soft 17)
        uint wordIdx = 1;
        while (wordIdx < randomWords.length && hand.dealerCardCount < MAX_CARDS) {
            uint8 dealerValue = _calculateHandValue(hand.dealerCards, hand.dealerCardCount);
            if (dealerValue > 17) break;
            if (dealerValue == 17 && !_isSoft(hand.dealerCards, hand.dealerCardCount)) break;

            uint8 card = _deriveCard(randomWords[wordIdx], 0);
            hand.dealerCards[hand.dealerCardCount] = card;
            hand.dealerCardCount++;
            wordIdx++;
        }

        _compareAndResolve(handId, hand);
    }

    /// @notice Same as _dealerPlayAndResolve but accepts memory array (used by doubleDown)
    function _dealerPlayAndResolveFromMemory(uint handId, Hand storage hand, uint256[] memory randomWords) internal {
        // Reveal dealer hidden card
        uint8 hiddenCard = _deriveCard(randomWords[0], 0);
        hand.dealerCards[hand.dealerCardCount] = hiddenCard;
        hand.dealerCardCount++;

        // Dealer draws until hard 17+ (hits on soft 17)
        uint wordIdx = 1;
        while (wordIdx < randomWords.length && hand.dealerCardCount < MAX_CARDS) {
            uint8 dealerValue = _calculateHandValue(hand.dealerCards, hand.dealerCardCount);
            if (dealerValue > 17) break;
            if (dealerValue == 17 && !_isSoft(hand.dealerCards, hand.dealerCardCount)) break;

            uint8 card = _deriveCard(randomWords[wordIdx], 0);
            hand.dealerCards[hand.dealerCardCount] = card;
            hand.dealerCardCount++;
            wordIdx++;
        }

        _compareAndResolve(handId, hand);
    }

    /// @notice Compares player and dealer hands and resolves the hand
    function _compareAndResolve(uint handId, Hand storage hand) internal {
        uint8 playerValue = _calculateHandValue(hand.playerCards, hand.playerCardCount);
        uint8 dealerValue = _calculateHandValue(hand.dealerCards, hand.dealerCardCount);

        if (dealerValue > 21) {
            _resolveHand(handId, hand, HandResult.DEALER_BUST);
        } else if (playerValue > dealerValue) {
            _resolveHand(handId, hand, HandResult.PLAYER_WIN);
        } else if (playerValue == dealerValue) {
            _resolveHand(handId, hand, HandResult.PUSH);
        } else {
            _resolveHand(handId, hand, HandResult.DEALER_WIN);
        }
    }

    /// @notice Resolves a hand with payout based on result
    function _resolveHand(uint handId, Hand storage hand, HandResult _result) internal {
        reservedProfitPerCollateral[hand.collateral] -= hand.reservedProfit;

        uint payout = 0;
        if (_result == HandResult.PLAYER_BLACKJACK) {
            payout = hand.amount + (hand.amount * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR;
        } else if (_result == HandResult.PLAYER_WIN || _result == HandResult.DEALER_BUST) {
            payout = hand.amount * 2;
        } else if (_result == HandResult.PUSH) {
            payout = hand.amount;
        }

        if (payout > 0) {
            if (isFreeBet[handId]) {
                uint profit = payout > hand.amount ? payout - hand.amount : 0;
                if (profit > 0) IERC20(hand.collateral).safeTransfer(hand.user, profit);
                IERC20(hand.collateral).safeTransfer(freeBetsHolder, hand.amount);
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

    /// @notice Cancels a pending hand, releases reserved liquidity and refunds stake
    function _setReferrer(address _referrer, address _user) internal {
        if (_referrer != address(0) && address(referrals) != address(0)) {
            referrals.setReferrer(_referrer, _user);
        }
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

        if (isFreeBet[handId]) {
            hand.payout = 0;
            IERC20(hand.collateral).safeTransfer(freeBetsHolder, hand.amount);
        } else {
            hand.payout = hand.amount;
            IERC20(hand.collateral).safeTransfer(hand.user, hand.amount);
        }

        emit HandCancelled(handId, hand.requestId, hand.user, hand.amount, adminCancelled);
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
        return uint8(((word >> (shiftIndex * 128)) % 13) + 1);
    }

    /// @notice Returns the card value for blackjack
    /// @param rank Card rank 1-13
    /// @return Card value (Ace=11, 2-10=face, J/Q/K=10)
    function _cardValue(uint8 rank) internal pure returns (uint8) {
        if (rank == 1) return 11; // Ace
        if (rank >= 11) return 10; // J, Q, K
        return rank;
    }

    /// @notice Calculates the best hand value (highest <= 21, or lowest if bust)
    function _calculateHandValue(uint8[11] storage cards, uint8 count) internal view returns (uint8) {
        uint8 total = 0;
        uint8 aces = 0;

        for (uint8 i = 0; i < count; i++) {
            uint8 val = _cardValue(cards[i]);
            total += val;
            if (cards[i] == 1) aces++;
        }

        while (total > 21 && aces > 0) {
            total -= 10;
            aces--;
        }

        return total;
    }

    /// @notice Returns whether a hand is soft (has an Ace counted as 11)
    function _isSoft(uint8[11] storage cards, uint8 count) internal view returns (bool) {
        uint8 total = 0;
        uint8 aces = 0;

        for (uint8 i = 0; i < count; i++) {
            uint8 val = _cardValue(cards[i]);
            total += val;
            if (cards[i] == 1) aces++;
        }

        while (total > 21 && aces > 0) {
            total -= 10;
            aces--;
        }

        return aces > 0;
    }

    /// @notice Returns whether two cards form a natural blackjack
    function _isBlackjack(uint8 card1, uint8 card2) internal pure returns (bool) {
        return _cardValue(card1) + _cardValue(card2) == 21;
    }

    /// @notice Checks whether available collateral balance covers all reserved profit
    function _hasEnoughLiquidity(address collateral) internal view returns (bool) {
        return IERC20(collateral).balanceOf(address(this)) >= reservedProfitPerCollateral[collateral];
    }

    /// @notice Returns the normalized price for a supported collateral
    function _getCollateralPrice(address collateral) internal view returns (uint) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();

        if (collateral == usdc) {
            return ONE;
        }

        bytes32 currencyKey = priceFeedKeyPerCollateral[collateral];
        if (currencyKey == bytes32(0)) revert InvalidCollateral();

        uint price = priceFeed.rateForCurrency(currencyKey);
        if (price == 0) revert InvalidPrice();

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
    function getMaxPayout(address collateral, uint amount) external pure returns (uint) {
        return amount + (amount * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR;
    }

    /// @notice Returns normalized collateral price
    function getCollateralPrice(address collateral) external view returns (uint) {
        return _getCollateralPrice(collateral);
    }

    /// @notice Returns currently available liquidity for a collateral after reserved profit
    function getAvailableLiquidity(address collateral) external view returns (uint) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
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
        for (uint i = 0; i < count; i++) {
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
        for (uint i = 0; i < count; i++) {
            ids[i] = start - i;
        }
    }

    /// @notice Returns player and dealer cards for a hand
    function getHandCards(uint handId) external view returns (uint8[] memory playerCards, uint8[] memory dealerCards) {
        Hand storage h = hands[handId];
        playerCards = new uint8[](h.playerCardCount);
        dealerCards = new uint8[](h.dealerCardCount);
        for (uint8 i = 0; i < h.playerCardCount; i++) playerCards[i] = h.playerCards[i];
        for (uint8 i = 0; i < h.dealerCardCount; i++) dealerCards[i] = h.dealerCards[i];
    }

    /* ========== SETTERS ========== */

    /// @notice Sets maximum allowed profit per hand in USD
    function setMaxProfitUsd(uint _maxProfitUsd) external onlyRiskManager {
        if (_maxProfitUsd == 0) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        emit MaxProfitUsdChanged(_maxProfitUsd);
    }

    /// @notice Sets timeout after which pending hands can be cancelled
    function setCancelTimeout(uint _cancelTimeout) external onlyRiskManager {
        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        cancelTimeout = _cancelTimeout;
        emit CancelTimeoutChanged(_cancelTimeout);
    }

    /// @notice Adds or removes a supported collateral
    function setSupportedCollateral(address collateral, bool isSupported) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        supportedCollateral[collateral] = isSupported;
        emit SupportedCollateralChanged(collateral, isSupported);
    }

    /// @notice Sets price feed key for a collateral
    function setPriceFeedKeyPerCollateral(address collateral, bytes32 currencyKey) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        priceFeedKeyPerCollateral[collateral] = currencyKey;
        emit PriceFeedKeyPerCollateralChanged(collateral, currencyKey);
    }

    /// @notice Sets manager contract address
    function setManager(address _manager) external onlyOwner {
        if (_manager == address(0)) revert InvalidAddress();
        manager = ISportsAMMV2Manager(_manager);
        emit ManagerChanged(_manager);
    }

    /// @notice Sets price feed contract address
    function setPriceFeed(address _priceFeed) external onlyOwner {
        if (_priceFeed == address(0)) revert InvalidAddress();
        priceFeed = IPriceFeed(_priceFeed);
        emit PriceFeedChanged(_priceFeed);
    }

    /// @notice Sets Chainlink VRF coordinator address
    function setVrfCoordinator(address _vrfCoordinator) external onlyOwner {
        if (_vrfCoordinator == address(0)) revert InvalidAddress();
        vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        emit VrfCoordinatorChanged(_vrfCoordinator);
    }

    /// @notice Sets the free bets holder contract
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit FreeBetsHolderChanged(_freeBetsHolder);
    }

    /// @notice Sets the referrals contract
    function setReferrals(address _referrals) external onlyOwner {
        referrals = IReferrals(_referrals);
        emit ReferralsChanged(_referrals);
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
        if (_callbackGasLimit == 0 || _requestConfirmations == 0) revert InvalidAmount();

        subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        callbackGasLimit = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
        nativePayment = _nativePayment;

        emit VrfConfigChanged(_subscriptionId, _keyHash, _callbackGasLimit, _requestConfirmations, _nativePayment);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyRiskManager() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.RISK_MANAGING)) {
            revert InvalidSender();
        }
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING)) {
            revert InvalidSender();
        }
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.TICKET_PAUSER)) {
            revert InvalidSender();
        }
        _;
    }

    /* ========== EVENTS ========== */

    event HandCreated(uint indexed handId, uint indexed requestId, address indexed user, address collateral, uint amount);

    event CardsDealt(uint indexed handId, address indexed user, uint8 playerCard1, uint8 playerCard2, uint8 dealerFaceUp);

    event HitRequested(uint indexed handId, uint indexed requestId, address indexed user);

    event PlayerCardDealt(uint indexed handId, address indexed user, uint8 card, uint8 handValue);

    event StandRequested(uint indexed handId, uint indexed requestId, address indexed user);

    event DoubleDownRequested(uint indexed handId, uint indexed requestId, address indexed user, uint additionalAmount);

    event HandResolved(uint indexed handId, uint indexed requestId, address indexed user, HandResult result, uint payout);

    event HandCancelled(
        uint indexed handId,
        uint indexed requestId,
        address indexed user,
        uint refundedAmount,
        bool adminCancelled
    );

    event MaxProfitUsdChanged(uint maxProfitUsd);
    event CancelTimeoutChanged(uint cancelTimeout);
    event SupportedCollateralChanged(address collateral, bool supported);
    event PriceFeedKeyPerCollateralChanged(address collateral, bytes32 key);
    event ManagerChanged(address manager);
    event PriceFeedChanged(address priceFeed);
    event VrfCoordinatorChanged(address vrfCoordinator);
    event FreeBetsHolderChanged(address freeBetsHolder);
    event ReferralsChanged(address referrals);
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
