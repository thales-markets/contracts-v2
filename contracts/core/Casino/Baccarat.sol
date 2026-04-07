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

/// @title Baccarat
/// @author Overtime
/// @notice Baccarat contract using Chainlink VRF for single-player bets
/// @dev Supports USDC, WETH and OVER collateral, with bankroll reservation per collateral
contract Baccarat is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant USDC_UNIT = 1e6;

    /// @notice Minimum allowed bet value expressed in USD, normalized to 18 decimals
    uint public constant MIN_BET_USD = 3e18;

    /// @notice Minimum allowed cancel timeout in seconds
    uint public constant MIN_CANCEL_TIMEOUT = 30;

    /// @notice Default total payout multiplier for winning Banker bets in 1e18 precision
    uint public constant DEFAULT_BANKER_PAYOUT = 195e16; // 1.95x

    /// @notice Minimum allowed total payout multiplier for winning Banker bets in 1e18 precision
    uint public constant MIN_BANKER_PAYOUT = 1e18; // 1.00x

    /// @notice Maximum allowed total payout multiplier for winning Banker bets in 1e18 precision
    uint public constant MAX_BANKER_PAYOUT = 2e18; // 2.00x

    uint8 private constant CARD_RANK_MIN = 1;
    uint8 private constant CARD_RANK_MAX = 13;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidSender();
    error InvalidCollateral();
    error InvalidPrice();
    error InvalidAmount();
    error InvalidBetType();
    error InvalidCardRank();
    error InvalidBankerPayoutMultiplier();
    error BetNotFound();
    error BetNotPending();
    error BetNotOwner();
    error CancelTimeoutNotReached();
    error MaxProfitExceeded();
    error InsufficientAvailableLiquidity();

    /* ========== ENUMS ========== */

    /// @notice Supported baccarat bet types
    enum BetType {
        PLAYER,
        BANKER,
        TIE
    }

    /// @notice Final baccarat game result
    enum GameResult {
        PLAYER,
        BANKER,
        TIE
    }

    /// @notice Lifecycle status of a baccarat bet
    enum BetStatus {
        NONE,
        PENDING,
        RESOLVED,
        CANCELLED
    }

    /* ========== STRUCTS ========== */

    /// @notice Stored data for an individual baccarat bet
    /// @param user Address of the bettor
    /// @param collateral Collateral token used for the bet
    /// @param amount Amount staked
    /// @param payout Final payout amount, 0 if lost, original amount if pushed/cancelled
    /// @param requestId Chainlink VRF request id
    /// @param placedAt Timestamp when the bet was placed
    /// @param resolvedAt Timestamp when the bet was resolved or cancelled
    /// @param reservedProfit Reserved house-side profit liability for this bet
    /// @param betType Type of baccarat bet
    /// @param status Current status of the bet
    /// @param result Final baccarat result
    /// @param won Whether the bet won
    /// @param isPush Whether the bet resulted in a push
    /// @param playerTotal Final player total
    /// @param bankerTotal Final banker total
    /// @param cards Array of 6 card values dealt during the game
    struct Bet {
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint requestId;
        uint placedAt;
        uint resolvedAt;
        uint reservedProfit;
        BetType betType;
        BetStatus status;
        GameResult result;
        bool won;
        bool isPush;
        uint8 playerTotal;
        uint8 bankerTotal;
        uint8[6] cards;
    }

    /// @notice Frontend-friendly view of a baccarat bet with all fields in one struct
    struct BetView {
        uint betId;
        address user;
        address collateral;
        uint amount;
        uint payout;
        uint requestId;
        uint placedAt;
        uint resolvedAt;
        uint reservedProfit;
        BetType betType;
        BetStatus status;
        GameResult result;
        bool won;
        bool isPush;
        uint8[6] cards;
        uint8 playerTotal;
        uint8 bankerTotal;
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

    /// @notice Internal struct for game resolution output
    struct ResolveResult {
        GameResult result;
        bool won;
        bool isPush;
        uint payout;
        uint8[6] cards;
        uint8 playerTotal;
        uint8 bankerTotal;
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

    /// @notice Maximum allowed profit per bet in USD, normalized to 18 decimals
    uint public maxProfitUsd;

    /// @notice Timeout after which a pending bet can be cancelled
    uint public cancelTimeout;

    /// @notice Total payout multiplier for winning Banker bets in 1e18 precision
    /// @dev Defaults to DEFAULT_BANKER_PAYOUT if initialize receives 0
    uint public bankerPayoutMultiplier;

    /// @notice Next bet id to assign
    uint public nextBetId;

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

    /// @notice Stored bets by bet id
    mapping(uint => Bet) internal _bets;

    /// @notice Maps VRF request id to bet id
    mapping(uint => uint) public requestIdToBetId;

    /// @notice Tracks reserved house-side profit liability for all pending bets per collateral
    mapping(address => uint) public reservedProfitPerCollateral;

    /// @notice Bet IDs per user for history queries
    mapping(address => uint[]) private userBetIds;

    /// @notice Free bets holder contract address
    address public freeBetsHolder;

    /// @notice Whether a bet was placed with a free bet
    mapping(uint => bool) public isFreeBet;

    /* ========== PUBLIC / EXTERNAL METHODS ========== */

    /// @notice Initializes the baccarat contract
    /// @param core Core protocol addresses
    /// @param collateralConfig Collateral addresses and price feed keys
    /// @param _maxProfitUsd Maximum allowed profit per bet in USD, normalized to 18 decimals
    /// @param _cancelTimeout Timeout after which a pending bet can be cancelled
    /// @param _bankerPayoutMultiplier Total payout multiplier for winning Banker bets in 1e18 precision. Pass 0 to use DEFAULT_BANKER_PAYOUT.
    /// @param vrfConfig Chainlink VRF configuration
    function initialize(
        CoreAddresses calldata core,
        CollateralConfig calldata collateralConfig,
        uint _maxProfitUsd,
        uint _cancelTimeout,
        uint _bankerPayoutMultiplier,
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

        if (_maxProfitUsd == 0) revert InvalidAmount();
        if (vrfConfig.callbackGasLimit == 0 || vrfConfig.requestConfirmations == 0) revert InvalidAmount();

        uint bankerMultiplierToSet = _bankerPayoutMultiplier == 0 ? DEFAULT_BANKER_PAYOUT : _bankerPayoutMultiplier;
        if (bankerMultiplierToSet < MIN_BANKER_PAYOUT || bankerMultiplierToSet > MAX_BANKER_PAYOUT) {
            revert InvalidBankerPayoutMultiplier();
        }

        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        cancelTimeout = _cancelTimeout;
        bankerPayoutMultiplier = bankerMultiplierToSet;

        subscriptionId = vrfConfig.subscriptionId;
        keyHash = vrfConfig.keyHash;
        callbackGasLimit = vrfConfig.callbackGasLimit;
        requestConfirmations = vrfConfig.requestConfirmations;
        nativePayment = vrfConfig.nativePayment;

        nextBetId = 1;
    }

    /// @notice Places a baccarat bet and requests randomness from Chainlink VRF
    function placeBet(
        address collateral,
        uint amount,
        BetType betType
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
        return _placeBet(msg.sender, collateral, amount, betType, false);
    }

    /// @notice Places a baccarat bet using free bet balance
    function placeBetWithFreeBet(
        address collateral,
        uint amount,
        BetType betType
    ) external nonReentrant notPaused returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        ICasinoFreeBetsHolder(freeBetsHolder).useFreeBet(msg.sender, collateral, amount);
        return _placeBet(msg.sender, collateral, amount, betType, true);
    }

    function _placeBet(
        address user,
        address collateral,
        uint amount,
        BetType betType,
        bool _isFreeBet
    ) internal returns (uint betId, uint requestId) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        if (amount == 0) revert InvalidAmount();

        _validateBetType(betType);

        uint amountUsd = _getUsdValue(collateral, amount);
        if (amountUsd < MIN_BET_USD) revert InvalidAmount();

        uint reservedProfit = _getReservedProfit(amount, betType);
        if (_getUsdValue(collateral, reservedProfit) > maxProfitUsd) revert MaxProfitExceeded();

        reservedProfitPerCollateral[collateral] += reservedProfit;
        if (!_hasEnoughLiquidity(collateral)) {
            reservedProfitPerCollateral[collateral] -= reservedProfit;
            revert InsufficientAvailableLiquidity();
        }

        requestId = _requestRandomWord();
        betId = nextBetId++;

        Bet storage bet = _bets[betId];
        bet.user = user;
        bet.collateral = collateral;
        bet.amount = amount;
        bet.requestId = requestId;
        bet.placedAt = block.timestamp;
        bet.reservedProfit = reservedProfit;
        bet.betType = betType;
        bet.status = BetStatus.PENDING;

        if (_isFreeBet) isFreeBet[betId] = true;

        requestIdToBetId[requestId] = betId;
        userBetIds[user].push(betId);

        emit BetPlaced(betId, requestId, user, collateral, amount, betType);
    }

    /// @notice Cancels a pending bet after timeout and refunds the original stake
    /// @param betId Bet id to cancel
    function cancelBet(uint betId) external nonReentrant {
        Bet storage bet = _bets[betId];

        if (bet.status == BetStatus.NONE) revert BetNotFound();
        if (bet.user != msg.sender) revert BetNotOwner();
        if (bet.status != BetStatus.PENDING) revert BetNotPending();
        if (block.timestamp < bet.placedAt + cancelTimeout) revert CancelTimeoutNotReached();

        _cancelBet(betId, false);
    }

    /// @notice Emergency cancels a pending bet and refunds the original stake
    /// @dev Callable by owner or manager role with MARKET_RESOLVING permission
    /// @param betId Bet id to cancel
    function adminCancelBet(uint betId) external onlyResolver nonReentrant {
        Bet storage bet = _bets[betId];

        if (bet.status == BetStatus.NONE) revert BetNotFound();
        if (bet.status != BetStatus.PENDING) revert BetNotPending();

        _cancelBet(betId, true);
    }

    /// @notice Pauses or unpauses the contract using manager-based pauser permissions
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
    /// @param requestId Chainlink VRF request id
    /// @param randomWords Array of VRF random words
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert InvalidSender();
        _fulfillRandomWords(requestId, randomWords);
    }

    /* ========== INTERNAL / PRIVATE ========== */

    /// @notice Internal baccarat resolution logic after VRF fulfillment
    /// @param requestId Chainlink VRF request id
    /// @param randomWords Array of VRF random words
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal {
        uint betId = requestIdToBetId[requestId];
        if (betId == 0) return;

        Bet storage bet = _bets[betId];
        if (bet.status != BetStatus.PENDING) return;

        _resolveBet(betId, bet, randomWords[0]);
    }

    /// @notice Resolves a bet: runs game logic, releases reserves, pays out, stores result, emits event
    /// @param betId Bet id
    /// @param bet Bet storage reference
    /// @param randomWord VRF random word
    function _resolveBet(uint betId, Bet storage bet, uint256 randomWord) internal {
        ResolveResult memory r = _resolveGame(bet.amount, bet.betType, randomWord);

        reservedProfitPerCollateral[bet.collateral] -= bet.reservedProfit;

        if (r.payout > 0) {
            if (isFreeBet[betId] && r.won) {
                uint profit = r.payout - bet.amount;
                if (profit > 0) IERC20(bet.collateral).safeTransfer(bet.user, profit);
                IERC20(bet.collateral).safeTransfer(freeBetsHolder, bet.amount);
            } else {
                IERC20(bet.collateral).safeTransfer(bet.user, r.payout);
            }
        }

        bet.result = r.result;
        bet.won = r.won;
        bet.isPush = r.isPush;
        bet.payout = r.payout;
        bet.playerTotal = r.playerTotal;
        bet.bankerTotal = r.bankerTotal;
        bet.cards = r.cards;
        bet.status = BetStatus.RESOLVED;
        bet.resolvedAt = block.timestamp;

        emit BetResolved(betId, bet.requestId, bet.user, r.result, r.won, r.isPush, r.payout, r.playerTotal, r.bankerTotal);
    }

    /// @notice Resolves a baccarat game from a single random word
    /// @param amount Bet amount
    /// @param betType Type of baccarat bet
    /// @param randomWord VRF random word
    /// @return r Resolution result containing game outcome, cards and totals
    function _resolveGame(uint amount, BetType betType, uint256 randomWord) internal view returns (ResolveResult memory r) {
        // Deal initial four cards
        r.cards[0] = _getCardValue(randomWord, 0);
        r.cards[1] = _getCardValue(randomWord, 1);
        r.cards[2] = _getCardValue(randomWord, 2);
        r.cards[3] = _getCardValue(randomWord, 3);

        r.playerTotal = _getHandTotal(r.cards[0], r.cards[2]);
        r.bankerTotal = _getHandTotal(r.cards[1], r.cards[3]);

        // Check for naturals
        if (!_isNatural(r.playerTotal) && !_isNatural(r.bankerTotal)) {
            bool playerDrew = _shouldPlayerDraw(r.playerTotal);
            uint8 playerThirdCard = 0;

            if (playerDrew) {
                r.cards[4] = _getCardValue(randomWord, 4);
                playerThirdCard = r.cards[4];
                r.playerTotal = _getHandTotal3(r.cards[0], r.cards[2], playerThirdCard);
            }

            if (_shouldBankerDraw(r.bankerTotal, playerDrew, playerThirdCard)) {
                r.cards[5] = _getCardValue(randomWord, 5);
                r.bankerTotal = _getHandTotal3(r.cards[1], r.cards[3], r.cards[5]);
            }
        }

        r.result = _getGameResult(r.playerTotal, r.bankerTotal);
        (r.payout, r.won, r.isPush) = _getPayout(amount, betType, r.result);
    }

    /// @notice Cancels a pending bet, releases reserved liquidity and refunds stake
    /// @param betId Bet id to cancel
    /// @param adminCancelled Whether the cancellation was admin-triggered
    function _cancelBet(uint betId, bool adminCancelled) internal {
        Bet storage bet = _bets[betId];

        reservedProfitPerCollateral[bet.collateral] -= bet.reservedProfit;

        bet.status = BetStatus.CANCELLED;
        bet.resolvedAt = block.timestamp;
        bet.payout = bet.amount;

        IERC20(bet.collateral).safeTransfer(bet.user, bet.amount);

        emit BetCancelled(betId, bet.requestId, bet.user, bet.amount, adminCancelled);
    }

    /// @notice Requests one random word from Chainlink VRF
    /// @return requestId Chainlink VRF request id
    function _requestRandomWord() internal returns (uint requestId) {
        requestId = vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
    }

    /// @notice Checks whether available collateral balance covers all reserved profit
    /// @param collateral Collateral token address
    /// @return True if bankroll is sufficient for the collateral
    function _hasEnoughLiquidity(address collateral) internal view returns (bool) {
        return IERC20(collateral).balanceOf(address(this)) >= reservedProfitPerCollateral[collateral];
    }

    /// @notice Returns the normalized price for a supported collateral
    /// @param collateral Collateral token address
    /// @return Collateral price normalized to 18 decimals
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
    /// @param collateral Collateral token address
    /// @param amount Collateral amount
    /// @return USD value normalized to 18 decimals
    function _getUsdValue(address collateral, uint amount) internal view returns (uint) {
        if (collateral == usdc) {
            return (amount * ONE) / USDC_UNIT;
        }

        uint price = _getCollateralPrice(collateral);
        return (amount * price) / ONE;
    }

    /// @notice Validates baccarat bet type
    /// @param betType Baccarat bet type
    function _validateBetType(BetType betType) internal pure {
        if (betType == BetType.PLAYER || betType == BetType.BANKER || betType == BetType.TIE) {
            return;
        }

        revert InvalidBetType();
    }

    /// @notice Returns reserved profit amount in collateral units for a winning bet
    /// @param amount Bet amount
    /// @param betType Baccarat bet type
    /// @return Reserved house-side profit liability
    function _getReservedProfit(uint amount, BetType betType) internal view returns (uint) {
        if (betType == BetType.PLAYER) {
            return amount;
        }

        if (betType == BetType.BANKER) {
            uint payout = (amount * bankerPayoutMultiplier) / ONE;
            return payout - amount;
        }

        if (betType == BetType.TIE) {
            return amount * 8;
        }

        revert InvalidBetType();
    }

    /// @notice Derives a card rank in range 1..13 from a random word and index
    /// @param randomWord VRF random word
    /// @param index Derivation index
    /// @return rank Card rank in range 1..13
    function _getCardRank(uint256 randomWord, uint index) internal pure returns (uint8 rank) {
        rank = uint8((uint256(keccak256(abi.encode(randomWord, index))) % CARD_RANK_MAX) + CARD_RANK_MIN);
    }

    /// @notice Maps a card rank to baccarat card value
    /// @param rank Card rank in range 1..13
    /// @return Card value in baccarat scoring
    function _getBaccaratCardValue(uint8 rank) internal pure returns (uint8) {
        if (rank < CARD_RANK_MIN || rank > CARD_RANK_MAX) revert InvalidCardRank();

        if (rank == 1) {
            return 1;
        }

        if (rank >= 2 && rank <= 9) {
            return rank;
        }

        return 0;
    }

    /// @notice Derives a baccarat card value directly from a random word and index
    /// @param randomWord VRF random word
    /// @param index Derivation index
    /// @return Card value in baccarat scoring
    function _getCardValue(uint256 randomWord, uint index) internal pure returns (uint8) {
        return _getBaccaratCardValue(_getCardRank(randomWord, index));
    }

    /// @notice Returns 2-card hand total modulo 10
    /// @param card1 First card value
    /// @param card2 Second card value
    /// @return Hand total
    function _getHandTotal(uint8 card1, uint8 card2) internal pure returns (uint8) {
        return uint8((card1 + card2) % 10);
    }

    /// @notice Returns 3-card hand total modulo 10
    /// @param card1 First card value
    /// @param card2 Second card value
    /// @param card3 Third card value
    /// @return Hand total
    function _getHandTotal3(uint8 card1, uint8 card2, uint8 card3) internal pure returns (uint8) {
        return uint8((card1 + card2 + card3) % 10);
    }

    /// @notice Returns whether the initial total is a natural
    /// @param total Baccarat hand total
    /// @return True if total is 8 or 9
    function _isNatural(uint8 total) internal pure returns (bool) {
        return total == 8 || total == 9;
    }

    /// @notice Returns whether Player should draw a third card
    /// @param playerTotal Player total after first two cards
    /// @return True if Player draws
    function _shouldPlayerDraw(uint8 playerTotal) internal pure returns (bool) {
        return playerTotal <= 5;
    }

    /// @notice Returns whether Banker should draw a third card
    /// @param bankerTotal Banker total after first two cards
    /// @param playerDrew Whether Player drew a third card
    /// @param playerThirdCard Player third card baccarat value, 0 if Player stood
    /// @return True if Banker draws
    function _shouldBankerDraw(uint8 bankerTotal, bool playerDrew, uint8 playerThirdCard) internal pure returns (bool) {
        if (!playerDrew) {
            return bankerTotal <= 5;
        }

        if (bankerTotal <= 2) return true;
        if (bankerTotal == 3) return playerThirdCard != 8;
        if (bankerTotal == 4) return playerThirdCard >= 2 && playerThirdCard <= 7;
        if (bankerTotal == 5) return playerThirdCard >= 4 && playerThirdCard <= 7;
        if (bankerTotal == 6) return playerThirdCard == 6 || playerThirdCard == 7;

        return false;
    }

    /// @notice Determines final baccarat game result from hand totals
    /// @param playerTotal Final player total
    /// @param bankerTotal Final banker total
    /// @return Final game result
    function _getGameResult(uint8 playerTotal, uint8 bankerTotal) internal pure returns (GameResult) {
        if (playerTotal > bankerTotal) return GameResult.PLAYER;
        if (bankerTotal > playerTotal) return GameResult.BANKER;
        return GameResult.TIE;
    }

    /// @notice Returns final payout, win flag and push flag for a baccarat bet
    /// @param amount Bet amount
    /// @param betType Baccarat bet type
    /// @param result Final game result
    /// @return payout Final payout amount
    /// @return won Whether the bet won
    /// @return isPush Whether the bet pushed
    function _getPayout(
        uint amount,
        BetType betType,
        GameResult result
    ) internal view returns (uint payout, bool won, bool isPush) {
        if (betType == BetType.PLAYER) {
            if (result == GameResult.PLAYER) return (amount * 2, true, false);
            if (result == GameResult.TIE) return (amount, false, true);
            return (0, false, false);
        }

        if (betType == BetType.BANKER) {
            if (result == GameResult.BANKER) return ((amount * bankerPayoutMultiplier) / ONE, true, false);
            if (result == GameResult.TIE) return (amount, false, true);
            return (0, false, false);
        }

        if (betType == BetType.TIE) {
            if (result == GameResult.TIE) return (amount * 9, true, false);
            return (0, false, false);
        }

        revert InvalidBetType();
    }

    /* ========== GETTERS ========== */

    /// @notice Returns bet data split across two calls to avoid stack-too-deep
    function getBetBase(
        uint betId
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
        Bet storage b = _bets[betId];
        return (b.user, b.collateral, b.amount, b.payout, b.requestId, b.placedAt, b.resolvedAt, b.reservedProfit);
    }

    /// @notice Returns bet status, result and game details
    function getBetDetails(
        uint betId
    )
        external
        view
        returns (
            BetType betType,
            BetStatus status,
            GameResult result,
            bool won,
            bool isPush,
            uint8[6] memory cards,
            uint8 playerTotal,
            uint8 bankerTotal
        )
    {
        Bet storage b = _bets[betId];
        return (b.betType, b.status, b.result, b.won, b.isPush, b.cards, b.playerTotal, b.bankerTotal);
    }

    /// @notice Returns potential profit in USD for a given bet
    /// @param collateral Collateral token address
    /// @param amount Bet amount
    /// @param betType Baccarat bet type
    /// @return Potential profit in USD normalized to 18 decimals
    function getPotentialProfit(address collateral, uint amount, BetType betType) external view returns (uint) {
        _validateBetType(betType);
        return _getUsdValue(collateral, _getReservedProfit(amount, betType));
    }

    /// @notice Returns total payout in collateral units for a winning bet
    /// @param amount Bet amount
    /// @param betType Baccarat bet type
    /// @return Total payout including original stake
    function getPotentialPayoutCollateral(uint amount, BetType betType) external view returns (uint) {
        _validateBetType(betType);

        if (betType == BetType.PLAYER) {
            return amount * 2;
        }

        if (betType == BetType.BANKER) {
            return (amount * bankerPayoutMultiplier) / ONE;
        }

        return amount * 9;
    }

    /// @notice Returns normalized collateral price
    /// @param collateral Collateral token address
    /// @return Collateral price normalized to 18 decimals
    function getCollateralPrice(address collateral) external view returns (uint) {
        return _getCollateralPrice(collateral);
    }

    /// @notice Returns currently available liquidity for a collateral after reserved profit
    /// @param collateral Collateral token address
    /// @return Available liquidity amount in collateral units
    function getAvailableLiquidity(address collateral) external view returns (uint) {
        if (!supportedCollateral[collateral]) revert InvalidCollateral();
        uint balance = IERC20(collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[collateral];
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Returns a baccarat card value for a given rank
    /// @param rank Card rank in range 1..13
    /// @return Baccarat card value
    function getBaccaratCardValue(uint8 rank) external pure returns (uint8) {
        return _getBaccaratCardValue(rank);
    }

    /// @notice Returns final baccarat game result from player and banker totals
    /// @param playerTotal Player total
    /// @param bankerTotal Banker total
    /// @return Final game result
    function getGameResult(uint8 playerTotal, uint8 bankerTotal) external pure returns (GameResult) {
        return _getGameResult(playerTotal, bankerTotal);
    }

    /// @notice Returns the number of bets placed by a user
    function getUserBetCount(address user) external view returns (uint) {
        return userBetIds[user].length;
    }

    /// @notice Returns full bet data for a user's bets with pagination
    function getUserBets(address user, uint offset, uint limit) external view returns (BetView[] memory views) {
        uint[] storage allIds = userBetIds[user];
        uint len = allIds.length;
        if (offset >= len) return new BetView[](0);
        uint remaining = len - offset;
        uint count = remaining < limit ? remaining : limit;
        views = new BetView[](count);
        for (uint i = 0; i < count; i++) {
            views[i] = _buildBetView(allIds[len - 1 - offset - i]);
        }
    }

    /// @notice Returns full bet data for recent bets with pagination
    function getRecentBets(uint offset, uint limit) external view returns (BetView[] memory views) {
        uint latest = nextBetId - 1;
        if (offset >= latest) return new BetView[](0);
        uint start = latest - offset;
        uint count = start < limit ? start : limit;
        views = new BetView[](count);
        for (uint i = 0; i < count; i++) {
            views[i] = _buildBetView(start - i);
        }
    }

    /// @notice Builds a BetView from storage for a given bet ID
    function _buildBetView(uint betId) internal view returns (BetView memory v) {
        Bet storage b = _bets[betId];
        v = BetView({
            betId: betId,
            user: b.user,
            collateral: b.collateral,
            amount: b.amount,
            payout: b.payout,
            requestId: b.requestId,
            placedAt: b.placedAt,
            resolvedAt: b.resolvedAt,
            reservedProfit: b.reservedProfit,
            betType: b.betType,
            status: b.status,
            result: b.result,
            won: b.won,
            isPush: b.isPush,
            cards: b.cards,
            playerTotal: b.playerTotal,
            bankerTotal: b.bankerTotal
        });
    }

    /* ========== SETTERS ========== */

    /// @notice Sets maximum allowed profit per bet in USD
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param _maxProfitUsd Maximum profit in USD normalized to 18 decimals
    function setMaxProfitUsd(uint _maxProfitUsd) external onlyRiskManager {
        if (_maxProfitUsd == 0) revert InvalidAmount();
        maxProfitUsd = _maxProfitUsd;
        emit MaxProfitUsdChanged(_maxProfitUsd);
    }

    /// @notice Sets timeout after which pending bets can be cancelled
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param _cancelTimeout Timeout in seconds
    function setCancelTimeout(uint _cancelTimeout) external onlyRiskManager {
        if (_cancelTimeout < MIN_CANCEL_TIMEOUT) revert InvalidAmount();
        cancelTimeout = _cancelTimeout;
        emit CancelTimeoutChanged(_cancelTimeout);
    }

    /// @notice Sets total payout multiplier for winning Banker bets
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param _bankerPayoutMultiplier Banker payout multiplier in 1e18 precision
    function setBankerPayoutMultiplier(uint _bankerPayoutMultiplier) external onlyRiskManager {
        if (_bankerPayoutMultiplier < MIN_BANKER_PAYOUT || _bankerPayoutMultiplier > MAX_BANKER_PAYOUT) {
            revert InvalidBankerPayoutMultiplier();
        }

        bankerPayoutMultiplier = _bankerPayoutMultiplier;
        emit BankerPayoutMultiplierChanged(_bankerPayoutMultiplier);
    }

    /// @notice Adds or removes a supported collateral
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param collateral Collateral token address
    /// @param isSupported Whether the collateral is supported
    function setSupportedCollateral(address collateral, bool isSupported) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        supportedCollateral[collateral] = isSupported;
        emit SupportedCollateralChanged(collateral, isSupported);
    }

    /// @notice Sets price feed key for a collateral
    /// @dev Callable by owner or manager role with RISK_MANAGING permission
    /// @param collateral Collateral token address
    /// @param currencyKey Price feed currency key
    function setPriceFeedKeyPerCollateral(address collateral, bytes32 currencyKey) external onlyRiskManager {
        if (collateral == address(0)) revert InvalidAddress();
        priceFeedKeyPerCollateral[collateral] = currencyKey;
        emit PriceFeedKeyPerCollateralChanged(collateral, currencyKey);
    }

    /// @notice Sets manager contract address
    /// @param _manager Manager contract address
    function setManager(address _manager) external onlyOwner {
        if (_manager == address(0)) revert InvalidAddress();
        manager = ISportsAMMV2Manager(_manager);
        emit ManagerChanged(_manager);
    }

    /// @notice Sets price feed contract address
    /// @param _priceFeed Price feed contract address
    function setPriceFeed(address _priceFeed) external onlyOwner {
        if (_priceFeed == address(0)) revert InvalidAddress();
        priceFeed = IPriceFeed(_priceFeed);
        emit PriceFeedChanged(_priceFeed);
    }

    /// @notice Sets Chainlink VRF coordinator address
    /// @param _vrfCoordinator Chainlink VRF coordinator address
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

    /// @notice Withdraws collateral from the contract bankroll
    /// @param _collateral The address of the ERC20 token to withdraw
    /// @param _recipient The address of the recipient, defaults to owner if zero address
    /// @param _amount The amount of tokens to withdraw
    function withdrawCollateral(address _collateral, address _recipient, uint _amount) external onlyOwner {
        uint balance = IERC20(_collateral).balanceOf(address(this));
        uint reserved = reservedProfitPerCollateral[_collateral];
        if (_amount > balance || balance - _amount < reserved) revert InsufficientAvailableLiquidity();
        address recipient = _recipient == address(0) ? owner : _recipient;
        IERC20(_collateral).safeTransfer(recipient, _amount);
        emit WithdrawnCollateral(_collateral, recipient, _amount);
    }

    /// @notice Sets Chainlink VRF configuration
    /// @param _subscriptionId Chainlink VRF subscription id
    /// @param _keyHash Chainlink VRF key hash / gas lane
    /// @param _callbackGasLimit Gas limit for callback
    /// @param _requestConfirmations Number of confirmations before VRF fulfillment
    /// @param _nativePayment Whether VRF uses native token payment
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

    /// @notice Restricts access to owner or manager addresses whitelisted for risk management
    modifier onlyRiskManager() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.RISK_MANAGING)) {
            revert InvalidSender();
        }
        _;
    }

    /// @notice Restricts access to owner or manager addresses whitelisted for market resolving
    modifier onlyResolver() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING)) {
            revert InvalidSender();
        }
        _;
    }

    /// @notice Restricts access to owner or manager addresses whitelisted for pausing
    modifier onlyPauser() {
        if (msg.sender != owner && !manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.TICKET_PAUSER)) {
            revert InvalidSender();
        }
        _;
    }

    /* ========== EVENTS ========== */

    /// @notice Emitted when a new bet is placed
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param collateral Collateral token address
    /// @param amount Bet amount
    /// @param betType Baccarat bet type
    event BetPlaced(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        address collateral,
        uint amount,
        BetType betType
    );

    /// @notice Emitted when a bet is resolved
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param result Final baccarat result
    /// @param won Whether the bet won
    /// @param isPush Whether the bet pushed
    /// @param payout Final payout amount
    /// @param playerTotal Final player total
    /// @param bankerTotal Final banker total
    event BetResolved(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        GameResult result,
        bool won,
        bool isPush,
        uint payout,
        uint8 playerTotal,
        uint8 bankerTotal
    );

    /// @notice Emitted when a bet is cancelled
    /// @param betId Bet id
    /// @param requestId Chainlink VRF request id
    /// @param user Bettor address
    /// @param refundedAmount Refunded stake amount
    /// @param adminCancelled Whether the cancellation was admin-triggered
    event BetCancelled(
        uint indexed betId,
        uint indexed requestId,
        address indexed user,
        uint refundedAmount,
        bool adminCancelled
    );

    /// @notice Emitted when maximum profit per bet is changed
    /// @param maxProfitUsd New maximum profit in USD normalized to 18 decimals
    event MaxProfitUsdChanged(uint maxProfitUsd);

    /// @notice Emitted when cancel timeout is changed
    /// @param cancelTimeout New timeout in seconds
    event CancelTimeoutChanged(uint cancelTimeout);

    /// @notice Emitted when house edge is changed
    /// @param houseEdge New house edge in 1e18 precision

    /// @notice Emitted when banker payout multiplier is changed
    /// @param bankerPayoutMultiplier New banker payout multiplier in 1e18 precision
    event BankerPayoutMultiplierChanged(uint bankerPayoutMultiplier);

    /// @notice Emitted when collateral support is changed
    /// @param collateral Collateral token address
    /// @param supported Whether the collateral is supported
    event SupportedCollateralChanged(address collateral, bool supported);

    /// @notice Emitted when price feed key for a collateral is changed
    /// @param collateral Collateral token address
    /// @param key New price feed key
    event PriceFeedKeyPerCollateralChanged(address collateral, bytes32 key);

    /// @notice Emitted when manager contract is changed
    /// @param manager New manager contract address
    event ManagerChanged(address manager);

    /// @notice Emitted when price feed contract is changed
    /// @param priceFeed New price feed contract address
    event PriceFeedChanged(address priceFeed);

    /// @notice Emitted when VRF coordinator is changed
    /// @param vrfCoordinator New Chainlink VRF coordinator address
    event VrfCoordinatorChanged(address vrfCoordinator);
    event FreeBetsHolderChanged(address freeBetsHolder);

    /// @notice Emitted when collateral is withdrawn from the bankroll
    /// @param collateral Collateral token address
    /// @param recipient Recipient address
    /// @param amount Amount withdrawn
    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint amount);

    /// @notice Emitted when VRF config is changed
    /// @param subscriptionId New Chainlink VRF subscription id
    /// @param keyHash New Chainlink VRF key hash
    /// @param callbackGasLimit New callback gas limit
    /// @param requestConfirmations New request confirmations value
    /// @param nativePayment Whether native payment is enabled
    event VrfConfigChanged(
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        bool nativePayment
    );
}
