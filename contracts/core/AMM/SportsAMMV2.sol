// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// internal
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";
import "@thales-dao/contracts/contracts/interfaces/IPriceFeed.sol";

import "./Ticket.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";
import "../../interfaces/ISportsAMMV2LiquidityPool.sol";
import "../../interfaces/IWeth.sol";
import "../../interfaces/IProxyBetting.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== LIBRARIES ========== */

    using SafeERC20 for IERC20;

    /* ========== CONST VARIABLES ========== */

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;
    uint8 private constant NON_SYSTEM_BET = 0;

    /* ========== ERRORS ========== */
    error SBDOutOfRange();
    error IllegalInputAmounts();
    error OnlyOwner();
    error OnlySGPProcessor();
    error OnlyLiveProcessor();
    error UndefinedRecipient();
    error UnknownTicket();
    error UnsupportedSender();
    error OfframpOnlyDefaultCollateralAllowed();
    error InsuffETHSent();
    error ZeroPriceForCollateral();
    error MultiCollateralDisabled();
    error InsuffReceived();
    error InvalidLength();
    error InvalidSender();
    error ZeroAmount();
    error InvalidPosition();
    error SafeBoxFeeTooHigh();
    error MultiCollatDisabled();
    error OnlyTicketOwner();

    /* ========== STRUCT VARIABLES ========== */
    struct TradeDataInternal {
        uint _buyInAmount;
        uint _expectedPayout;
        uint _additionalSlippage;
        address _recipient;
        bool _isLive;
        address _collateral;
        address _collateralPool;
        uint _collateralPriceInUSD;
        bool _isSGP;
    }

    /* ========== STATE VARIABLES ========== */

    // merkle tree root per game
    mapping(bytes32 => bytes32) public rootPerGame;

    // the default token used for payment
    IERC20 public defaultCollateral;

    // Liquidity pool instance for the given collateral
    mapping(address => address) public liquidityPoolForCollateral;

    // decimals of the default collateral
    uint private defaultCollateralDecimals;

    // manager address
    ISportsAMMV2Manager public manager;

    // risk manager address
    ISportsAMMV2RiskManager public riskManager;

    // result manager address
    ISportsAMMV2ResultManager public resultManager;

    // referrals address
    IReferrals public referrals;

    // ticket mastercopy address
    address public ticketMastercopy;

    // safe box address
    address public safeBox;

    // safe box fee paid on each trade
    uint public safeBoxFee;

    // multi-collateral on/off ramp address
    IMultiCollateralOnOffRamp public multiCollateralOnOffRamp;

    // is multi-collateral enabled
    bool public multicollateralEnabled;

    // staking thales address
    IStakingThales private stakingThales;

    // CL client that processes live requests
    address public liveTradingProcessor;

    // the contract that processes all free bets
    address public freeBetsHolder;

    // support bonus payouts for some collaterals (e.g. THALES)
    mapping(address => uint) public addedPayoutPercentagePerCollateral;

    // support different SB per collateral, namely THALES as a collateral will be directly burned
    mapping(address => address) public safeBoxPerCollateral;

    // the contract that processes betting with StakedTHALES
    address public stakingThalesBettingProxy;

    struct TradeDataQuoteInternal {
        uint _buyInAmount;
        bool _shouldCheckRisks;
        uint _buyInAmountInDefaultCollateral;
        address _collateral;
        bool _isLive;
        bool _isSGP;
        uint _approvedQuote;
    }

    struct TradeProcessingParams {
        uint _totalQuote;
        uint _payout;
        uint _fees;
        uint _addedPayoutPercentage;
        uint _payoutWithFees;
    }

    // CL client that processes SGP requests
    address public sgpTradingProcessor;

    struct TradeTypeData {
        uint8 _systemBetDenominator;
        bool _isSGP;
        bool _isLive;
    }

    // declare that it can receive eth
    receive() external payable {}

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the storage in the proxy contract with the parameters
    /// @param _owner owner for using the onlyOwner functions
    /// @param _defaultCollateral the address of default token used for payment
    /// @param _manager the address of manager
    /// @param _riskManager the address of risk manager
    /// @param _riskManager the address of result manager
    /// @param _referrals the address of referrals
    /// @param _safeBox the address of safe box
    function initialize(
        address _owner,
        IERC20 _defaultCollateral,
        ISportsAMMV2Manager _manager,
        ISportsAMMV2RiskManager _riskManager,
        ISportsAMMV2ResultManager _resultManager,
        IReferrals _referrals,
        address _safeBox
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        _setAddresses(
            _defaultCollateral,
            address(_manager),
            address(_riskManager),
            address(_resultManager),
            address(_referrals),
            _safeBox
        );
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice get roots for the list of games
    /// @param _games to return roots for
    /// @notice get roots for the list of games
    /// @param _games to return roots for
    function getRootsPerGames(bytes32[] calldata _games) external view returns (bytes32[] memory _roots) {
        uint len = _games.length;
        _roots = new bytes32[](len);

        unchecked {
            for (uint i; i < len; ++i) {
                _roots[i] = rootPerGame[_games[i]];
            }
        }
    }

    /// @notice gets trade quote
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _collateral different collateral used for payment
    /// @param _isLive whether this is a live bet
    /// @return totalQuote total ticket quote
    /// @return payout expected payout
    /// @return fees ticket fees
    /// @return amountsToBuy amounts per market
    /// @return buyInAmountInDefaultCollateral buy-in amount in default collateral
    /// @return riskStatus risk status
    function tradeQuote(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        address _collateral,
        bool _isLive
    )
        external
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            uint buyInAmountInDefaultCollateral,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        (totalQuote, payout, fees, amountsToBuy, buyInAmountInDefaultCollateral, riskStatus) = _tradeQuoteCommon(
            _tradeData,
            _buyInAmount,
            _collateral,
            _isLive,
            NON_SYSTEM_BET
        );
    }

    /// @notice gets trade quote
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _collateral different collateral used for payment
    /// @param _isLive whether this is a live bet
    /// @param _systemBetDenominator the denominator for system bets
    /// @return totalQuote total ticket quote
    /// @return payout expected payout
    /// @return fees ticket fees
    /// @return amountsToBuy amounts per market
    /// @return buyInAmountInDefaultCollateral buy-in amount in default collateral
    /// @return riskStatus risk status
    function tradeQuoteSystem(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        address _collateral,
        bool _isLive,
        uint8 _systemBetDenominator
    )
        external
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            uint buyInAmountInDefaultCollateral,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        (totalQuote, payout, fees, amountsToBuy, buyInAmountInDefaultCollateral, riskStatus) = _tradeQuoteCommon(
            _tradeData,
            _buyInAmount,
            _collateral,
            _isLive,
            _systemBetDenominator
        );
    }

    function _tradeQuoteCommon(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        address _collateral,
        bool _isLive,
        uint8 _systemBetDenominator
    )
        internal
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            uint buyInAmountInDefaultCollateral,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        uint useAmount = _buyInAmount;
        buyInAmountInDefaultCollateral = _buyInAmount;

        if (_collateral != address(0) && _collateral != address(defaultCollateral)) {
            address liqPoolToUse = liquidityPoolForCollateral[_collateral];
            if (liqPoolToUse == address(0)) {
                buyInAmountInDefaultCollateral = multiCollateralOnOffRamp.getMinimumReceived(_collateral, _buyInAmount);
                useAmount = buyInAmountInDefaultCollateral;
            } else {
                buyInAmountInDefaultCollateral = _transformToUSD(
                    _buyInAmount,
                    ISportsAMMV2LiquidityPool(liqPoolToUse).getCollateralPrice(),
                    defaultCollateralDecimals,
                    ISportsAMMV2Manager(_collateral).decimals()
                );
            }
        }

        if (useAmount == 0) revert ZeroAmount();

        (totalQuote, payout, fees, amountsToBuy, riskStatus) = _tradeQuote(
            _tradeData,
            TradeDataQuoteInternal(useAmount, true, buyInAmountInDefaultCollateral, _collateral, _isLive, false, 0),
            _systemBetDenominator
        );
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice make a trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedQuote expected payout got from quote method
    /// @param _additionalSlippage slippage tolerance
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @param _isEth pay with ETH
    /// @return _createdTicket the address of the created ticket
    function trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        bool _isEth
    ) external payable nonReentrant notPaused returns (address _createdTicket) {
        _createdTicket = _tradeInternal(
            _tradeData,
            TradeTypeData(NON_SYSTEM_BET, false, false),
            _buyInAmount,
            _expectedQuote,
            _additionalSlippage,
            _referrer,
            _collateral,
            _isEth,
            msg.sender
        );
    }

    /// @notice make a SGP trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _approvedQuote quote approved by sgpTradingProcessor
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @return _createdTicket the address of the created ticket
    function tradeSGP(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _approvedQuote,
        address _recipient,
        address _referrer,
        address _collateral
    ) external payable nonReentrant notPaused onlyValidRecipient(_recipient) returns (address _createdTicket) {
        if (msg.sender != sgpTradingProcessor) revert OnlySGPProcessor();

        _createdTicket = _tradeInternal(
            _tradeData,
            TradeTypeData(NON_SYSTEM_BET, true, false),
            _buyInAmount,
            _approvedQuote,
            0, //no additional slippage as quote is assigned by CL node
            _referrer,
            _collateral,
            false,
            _recipient
        );
    }

    /// @notice make a trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedQuote expected payout got from quote method
    /// @param _additionalSlippage slippage tolerance
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @param _isEth pay with ETH
    /// @param _systemBetDenominator minimum number of winning bets for a system bet
    /// @return _createdTicket the address of the created ticket
    function tradeSystemBet(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        bool _isEth,
        uint8 _systemBetDenominator
    ) external payable nonReentrant notPaused returns (address _createdTicket) {
        if (!(_systemBetDenominator > 1 && _systemBetDenominator < _tradeData.length)) revert SBDOutOfRange();
        _createdTicket = _tradeInternal(
            _tradeData,
            TradeTypeData(_systemBetDenominator, false, false),
            _buyInAmount,
            _expectedQuote,
            _additionalSlippage,
            _referrer,
            _collateral,
            _isEth,
            msg.sender
        );
    }

    /// @notice make a live trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedQuote expected payout got from LiveTradingProcessor method
    /// @param _recipient different recipient of the ticket
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @return _createdTicket the address of the created ticket
    function tradeLive(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        address _recipient,
        address _referrer,
        address _collateral
    ) external nonReentrant notPaused onlyValidRecipient(_recipient) returns (address _createdTicket) {
        if (msg.sender != liveTradingProcessor) revert OnlyLiveProcessor();

        _createdTicket = _tradeInternal(
            _tradeData,
            TradeTypeData(NON_SYSTEM_BET, false, true),
            _buyInAmount,
            _expectedQuote,
            0, //no additional slippage as quote is assigned by CL node
            _referrer,
            _collateral,
            false,
            _recipient
        );
    }

    function _tradeInternal(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeTypeData memory _tradeTypeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        bool _isEth,
        address _recipient
    ) internal returns (address _createdTicket) {
        if (_expectedQuote == 0 || _buyInAmount == 0) revert IllegalInputAmounts();

        _setReferrer(_referrer, _recipient);

        address useLPpool;
        uint collateralPriceInUSD;
        (useLPpool, collateralPriceInUSD, _buyInAmount, _collateral) = _handleCollateral(
            _buyInAmount,
            _collateral,
            _recipient,
            _isEth
        );
        _createdTicket = _trade(
            _tradeData,
            TradeDataInternal(
                _buyInAmount,
                _divWithDecimals(_buyInAmount, _expectedQuote), // quote to expected payout
                _additionalSlippage,
                _recipient,
                _tradeTypeData._isLive,
                _collateral,
                useLPpool,
                collateralPriceInUSD,
                _tradeTypeData._isSGP
            ),
            _tradeTypeData._systemBetDenominator
        );
    }

    /**
     * @notice Resolves a ticket by exercising, canceling, or marking it as lost.
     * @dev
     * - Anyone can call this to exercise a ticket.
     * - Only addresses whitelisted as MARKET_RESOLVING can cancel or mark a ticket as lost.
     * - Uses internal _exerciseTicket logic with the appropriate flags.
     * @param _ticket The address of the ticket to be resolved.
     * @param action The type of resolution action to perform:
     *   - TicketAction.Exercise: Exercise a resolved ticket (no whitelist required)
     *   - TicketAction.Cancel: Cancel the ticket (whitelist required)
     *   - TicketAction.MarkLost: Mark the ticket as lost (whitelist required)
     */
    function handleTicketResolving(
        address _ticket,
        ISportsAMMV2.TicketAction action
    ) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        if (action != ISportsAMMV2.TicketAction.Exercise) {
            if (!manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING)) {
                revert UnsupportedSender();
            }
        }

        if (action == ISportsAMMV2.TicketAction.Cancel) {
            _exerciseTicket(_ticket, address(0), false, true, false);
        } else if (action == ISportsAMMV2.TicketAction.MarkLost) {
            _exerciseTicket(_ticket, address(0), false, false, true);
        } else {
            _exerciseTicket(_ticket, address(0), false, false, false);
        }
    }

    /// @notice exercise specific ticket to an off ramp collateral
    /// @param _ticket ticket address
    /// @param _exerciseCollateral collateral address to off ramp to
    /// @param _inEth offramp with ETH
    function exerciseTicketOffRamp(
        address _ticket,
        address _exerciseCollateral,
        bool _inEth
    ) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        if (msg.sender != Ticket(_ticket).ticketOwner()) revert OnlyTicketOwner();
        _exerciseTicket(_ticket, _exerciseCollateral, _inEth, false, false);
    }

    /// @notice Withdraws collateral from a specified Ticket contract and sends it to the target address
    /// @param ticketAddress The address of the Ticket contract
    /// @param recipient The address to receive the withdrawn collateral
    function withdrawCollateralFromTicket(address ticketAddress, address recipient) external onlyOwner {
        // Call withdrawCollateral on the specified Ticket contract
        Ticket(ticketAddress).withdrawCollateral(recipient);
    }

    /// @notice expire provided tickets
    /// @param _tickets array of tickets to be expired
    function expireTickets(address[] calldata _tickets) external onlyOwner {
        unchecked {
            for (uint i; i < _tickets.length; ++i) {
                address ticketAddress = _tickets[i];
                address ticketOwner = Ticket(ticketAddress).ticketOwner();
                if (ticketOwner != freeBetsHolder && ticketOwner != stakingThalesBettingProxy) {
                    Ticket(ticketAddress).expire(msg.sender);
                    manager.expireKnownTicket(ticketAddress, ticketOwner);
                }
            }
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _tradeQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeDataQuoteInternal memory _tradeDataQuoteInternal,
        uint8 _systemBetDenominator
    )
        internal
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        uint numOfMarkets = _tradeData.length;
        amountsToBuy = new uint[](numOfMarkets);
        uint maxSupportedOdds = riskManager.maxSupportedOdds();
        bool isSystemBet = _systemBetDenominator > 1;

        uint addedPayoutPercentage = addedPayoutPercentagePerCollateral[_tradeDataQuoteInternal._collateral];

        for (uint i; i < numOfMarkets; ++i) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            riskManager.verifyMerkleTree(marketTradeData, rootPerGame[marketTradeData.gameId]);

            if (marketTradeData.odds.length <= marketTradeData.position) revert InvalidPosition();

            uint marketOdds = marketTradeData.odds[marketTradeData.position];
            marketOdds =
                (marketOdds * ONE) /
                ((ONE + addedPayoutPercentage) - _mulWithDecimals(addedPayoutPercentage, marketOdds));

            amountsToBuy[i] =
                _divWithDecimals(_tradeDataQuoteInternal._buyInAmount, marketOdds) -
                _tradeDataQuoteInternal._buyInAmount;
            if (isSystemBet) {
                amountsToBuy[i] = (amountsToBuy[i] * ONE * _systemBetDenominator) / (numOfMarkets * ONE);
            }
            // amounts to buy should be decreased by buyinamount
            totalQuote = totalQuote == 0 ? marketOdds : _mulWithDecimals(totalQuote, marketOdds);
        }
        if (totalQuote != 0) {
            if (isSystemBet) {
                (payout, totalQuote) = riskManager.getMaxSystemBetPayout(
                    _tradeData,
                    _systemBetDenominator,
                    _tradeDataQuoteInternal._buyInAmount,
                    addedPayoutPercentage
                );
            } else {
                if (_tradeDataQuoteInternal._isSGP) {
                    totalQuote = _tradeDataQuoteInternal._approvedQuote;
                    totalQuote =
                        (totalQuote * ONE) /
                        ((ONE + addedPayoutPercentage) - _mulWithDecimals(addedPayoutPercentage, totalQuote));
                }
                payout = _divWithDecimals(_tradeDataQuoteInternal._buyInAmount, totalQuote);
            }
            if (totalQuote < maxSupportedOdds) {
                totalQuote = maxSupportedOdds;
                payout = _divWithDecimals(_tradeDataQuoteInternal._buyInAmount, totalQuote);
            }

            fees = _getFees(_tradeDataQuoteInternal._buyInAmount);

            if (_tradeDataQuoteInternal._shouldCheckRisks) {
                bool[] memory isMarketOutOfLiquidity;
                (riskStatus, isMarketOutOfLiquidity) = riskManager.checkRisks(
                    _tradeData,
                    _tradeDataQuoteInternal._buyInAmountInDefaultCollateral,
                    _tradeDataQuoteInternal._isLive,
                    _systemBetDenominator
                );

                unchecked {
                    for (uint i; i < numOfMarkets; ++i) {
                        if (isMarketOutOfLiquidity[i]) amountsToBuy[i] = 0;
                    }
                }

                if (riskStatus != ISportsAMMV2RiskManager.RiskStatus.NoRisk) {
                    totalQuote = 0;
                    payout = 0;
                }
            }
        }
    }

    function _handleCollateral(
        uint _buyInAmount,
        address _collateral,
        address _fromAddress,
        bool _isEth
    ) internal returns (address lqPool, uint collateralPrice, uint buyInAmount, address collateralAfterOnramp) {
        buyInAmount = _buyInAmount;
        collateralAfterOnramp = _collateral;

        if (_collateral == address(0) || _collateral == address(defaultCollateral)) {
            collateralAfterOnramp = address(defaultCollateral);
            defaultCollateral.safeTransferFrom(_fromAddress, address(this), _buyInAmount);
        } else {
            if (_isEth) {
                if (!(_collateral == multiCollateralOnOffRamp.WETH9() && msg.value >= _buyInAmount)) revert InsuffETHSent();
                IWeth(_collateral).deposit{value: msg.value}();
            } else {
                IERC20(_collateral).safeTransferFrom(_fromAddress, address(this), _buyInAmount);
            }

            lqPool = liquidityPoolForCollateral[_collateral];
            if (lqPool != address(0)) {
                collateralPrice = ISportsAMMV2LiquidityPool(lqPool).getCollateralPrice();
                if (collateralPrice == 0) revert ZeroPriceForCollateral();
            } else {
                if (!multicollateralEnabled) revert MultiCollatDisabled();

                uint minReceived = multiCollateralOnOffRamp.getMinimumReceived(_collateral, _buyInAmount);
                IERC20(_collateral).approve(address(multiCollateralOnOffRamp), _buyInAmount);
                buyInAmount = multiCollateralOnOffRamp.onramp(_collateral, _buyInAmount);
                if (buyInAmount < minReceived) revert InsuffReceived();

                collateralAfterOnramp = address(defaultCollateral);
            }
        }
        lqPool = liquidityPoolForCollateral[collateralAfterOnramp];
    }

    function _trade(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeDataInternal memory _tradeDataInternal,
        uint8 _systemBetDenominator
    ) internal returns (address) {
        TradeProcessingParams memory processingParams;
        processingParams._addedPayoutPercentage = addedPayoutPercentagePerCollateral[_tradeDataInternal._collateral];

        if (!_tradeDataInternal._isLive) {
            (processingParams._totalQuote, processingParams._payout, processingParams._fees, , ) = _tradeQuote(
                _tradeData,
                TradeDataQuoteInternal(
                    _tradeDataInternal._buyInAmount,
                    false,
                    0,
                    _tradeDataInternal._collateral,
                    _tradeDataInternal._isLive,
                    _tradeDataInternal._isSGP,
                    _divWithDecimals(_tradeDataInternal._buyInAmount, _tradeDataInternal._expectedPayout)
                ),
                _systemBetDenominator
            );
        } else {
            processingParams._totalQuote = _divWithDecimals(
                _tradeDataInternal._buyInAmount,
                _tradeDataInternal._expectedPayout
            );
            processingParams._totalQuote =
                (processingParams._totalQuote * ONE) /
                ((ONE + processingParams._addedPayoutPercentage) -
                    _mulWithDecimals(processingParams._addedPayoutPercentage, processingParams._totalQuote));
            processingParams._payout = _divWithDecimals(_tradeDataInternal._buyInAmount, processingParams._totalQuote);
            processingParams._fees = _getFees(_tradeDataInternal._buyInAmount);
        }

        processingParams._payoutWithFees = processingParams._payout + processingParams._fees;

        checkRisksLimits(
            _tradeData,
            processingParams._totalQuote,
            processingParams._payout,
            _tradeDataInternal,
            _systemBetDenominator
        );

        // Clone a ticket
        Ticket.MarketData[] memory markets = _getTicketMarkets(_tradeData, processingParams._addedPayoutPercentage);
        Ticket ticket = Ticket(Clones.clone(ticketMastercopy));

        ticket.initialize(
            Ticket.TicketInit(
                markets,
                _tradeDataInternal._buyInAmount,
                processingParams._fees,
                processingParams._totalQuote,
                address(this),
                _tradeDataInternal._recipient,
                IERC20(_tradeDataInternal._collateral),
                (block.timestamp + riskManager.expiryDuration()),
                _tradeDataInternal._isLive,
                _systemBetDenominator,
                _tradeDataInternal._isSGP
            )
        );

        manager.addNewKnownTicket(_tradeData, address(ticket), _tradeDataInternal._recipient);

        ISportsAMMV2LiquidityPool(_tradeDataInternal._collateralPool).commitTrade(
            address(ticket),
            processingParams._payoutWithFees - _tradeDataInternal._buyInAmount
        );
        IERC20(_tradeDataInternal._collateral).safeTransfer(address(ticket), processingParams._payoutWithFees);

        emit NewTicket(
            markets,
            address(ticket),
            _tradeDataInternal._buyInAmount,
            processingParams._payout,
            _tradeDataInternal._isLive
        );
        emit TicketCreated(
            address(ticket),
            _tradeDataInternal._recipient,
            _tradeDataInternal._buyInAmount,
            processingParams._fees,
            processingParams._payout,
            processingParams._totalQuote,
            _tradeDataInternal._collateral
        );

        return address(ticket);
    }

    // Transform collateral to USD
    function _transformToUSD(
        uint _amountInCollateral,
        uint _collateralPriceInUSD,
        uint _defaultCollateralDecimals,
        uint _collateralDecimals
    ) internal pure returns (uint amountInUSD) {
        amountInUSD = _mulWithDecimals(_amountInCollateral, _collateralPriceInUSD);
        if (_collateralDecimals < _defaultCollateralDecimals) {
            amountInUSD = amountInUSD * 10 ** (_defaultCollateralDecimals - _collateralDecimals);
        } else if (_collateralDecimals > _defaultCollateralDecimals) {
            amountInUSD = amountInUSD / 10 ** (_collateralDecimals - _defaultCollateralDecimals);
        }
    }

    // Checks risk and updates Staking Volume
    function checkRisksLimits(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _totalQuote,
        uint _payout,
        TradeDataInternal memory _tradeDataInternal,
        uint8 _systemBetDenominator
    ) internal {
        uint _buyInAmount = _tradeDataInternal._buyInAmount;
        uint _collateralPriceInUSD = _tradeDataInternal._collateralPriceInUSD;
        uint _expectedPayout = _tradeDataInternal._expectedPayout;
        if (_collateralPriceInUSD > 0) {
            uint collateralDecimals = ISportsAMMV2Manager(_tradeDataInternal._collateral).decimals();
            _buyInAmount = _transformToUSD(
                _buyInAmount,
                _collateralPriceInUSD,
                defaultCollateralDecimals,
                collateralDecimals
            );
            _payout = _transformToUSD(_payout, _collateralPriceInUSD, defaultCollateralDecimals, collateralDecimals);
            _expectedPayout = _transformToUSD(
                _expectedPayout,
                _collateralPriceInUSD,
                defaultCollateralDecimals,
                collateralDecimals
            );
        }
        riskManager.checkAndUpdateRisks(
            _tradeData,
            _buyInAmount,
            _payout,
            _tradeDataInternal._isLive,
            _systemBetDenominator,
            _tradeDataInternal._isSGP
        );
        riskManager.checkLimits(
            _buyInAmount,
            _totalQuote,
            _payout,
            _expectedPayout,
            _tradeDataInternal._additionalSlippage,
            _tradeData.length
        );
    }

    function _getTicketMarkets(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _addedPayoutPercentage
    ) internal pure returns (Ticket.MarketData[] memory markets) {
        uint len = _tradeData.length;
        markets = new Ticket.MarketData[](len);

        for (uint i; i < len; ++i) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];
            uint odds = marketTradeData.odds[marketTradeData.position];

            markets[i] = Ticket.MarketData(
                marketTradeData.gameId,
                marketTradeData.sportId,
                marketTradeData.typeId,
                marketTradeData.maturity,
                marketTradeData.status,
                marketTradeData.line,
                marketTradeData.playerId,
                marketTradeData.position,
                (odds * ONE) / ((ONE + _addedPayoutPercentage) - _mulWithDecimals(_addedPayoutPercentage, odds)),
                marketTradeData.combinedPositions[marketTradeData.position]
            );
        }
    }

    function _handleFees(uint _buyInAmount, address _tickerOwner, IERC20 _collateral) internal returns (uint fees) {
        uint referrerShare;
        address referrer = referrals.sportReferrals(_tickerOwner);
        uint ammBalance = _collateral.balanceOf(address(this));

        if (referrer != address(0)) {
            uint referrerFeeByTier = referrals.getReferrerFee(referrer);
            if (referrerFeeByTier > 0) {
                referrerShare = _mulWithDecimals(_buyInAmount, referrerFeeByTier);
                if (ammBalance >= referrerShare) {
                    _collateral.safeTransfer(referrer, referrerShare);
                    emit ReferrerPaid(referrer, _tickerOwner, referrerShare, _buyInAmount, address(_collateral));
                    ammBalance -= referrerShare;
                }
            }
        }
        fees = _getFees(_buyInAmount);
        if (fees > referrerShare) {
            uint safeBoxAmount = fees - referrerShare;
            if (ammBalance >= safeBoxAmount) {
                address _safeBoxPerCollateral = safeBoxPerCollateral[address(_collateral)];
                _collateral.safeTransfer(
                    _safeBoxPerCollateral != address(0) ? _safeBoxPerCollateral : safeBox,
                    safeBoxAmount
                );
                emit SafeBoxFeePaid(safeBoxFee, safeBoxAmount, address(_collateral));
            }
        }
    }

    function _getFees(uint _buyInAmount) internal view returns (uint) {
        return (_buyInAmount * safeBoxFee) / ONE;
    }

    function _divWithDecimals(uint _dividend, uint _divisor) internal pure returns (uint) {
        return (ONE * _dividend) / _divisor;
    }

    function _mulWithDecimals(uint _firstMul, uint _secondMul) internal pure returns (uint) {
        return (_firstMul * _secondMul) / ONE;
    }

    function _setReferrer(address _referrer, address _recipient) internal {
        if (_referrer != address(0)) referrals.setReferrer(_referrer, _recipient);
    }

    function _exerciseTicket(
        address _ticket,
        address _exerciseCollateral,
        bool _inEth,
        bool _cancelTicket,
        bool _markLost
    ) internal {
        Ticket ticket = Ticket(_ticket);
        uint userWonAmount;
        if (_markLost) {
            userWonAmount = ticket.markAsLost();
        } else if (_cancelTicket) {
            userWonAmount = ticket.cancel();
        } else {
            userWonAmount = ticket.exercise(_exerciseCollateral);
        }
        IERC20 ticketCollateral = ticket.collateral();
        address ticketOwner = ticket.ticketOwner();

        if (ticketOwner == freeBetsHolder || ticketOwner == stakingThalesBettingProxy) {
            IProxyBetting(ticketOwner).confirmTicketResolved(_ticket);
        }
        if (!ticket.cancelled()) {
            _handleFees(ticket.buyInAmount(), ticketOwner, ticketCollateral);
        }
        manager.resolveKnownTicket(_ticket, ticketOwner);
        emit TicketResolved(_ticket, ticketOwner, ticket.isUserTheWinner());

        if (userWonAmount > 0 && _exerciseCollateral != address(0) && _exerciseCollateral != address(ticketCollateral)) {
            if (ticketCollateral != defaultCollateral) revert OfframpOnlyDefaultCollateralAllowed();

            if (_inEth) {
                require(
                    payable(ticketOwner).send(multiCollateralOnOffRamp.offrampIntoEth(userWonAmount)),
                    "ETHSendingFailed"
                );
            } else {
                IERC20(_exerciseCollateral).safeTransfer(
                    ticketOwner,
                    multiCollateralOnOffRamp.offramp(_exerciseCollateral, userWonAmount)
                );
            }
        }

        // mark ticket as exercised in LiquidityPool and return any funds to the pool if ticket was lost or cancelled
        ISportsAMMV2LiquidityPool(liquidityPoolForCollateral[address(ticketCollateral)]).transferToPool(
            _ticket,
            ticketCollateral.balanceOf(address(this))
        );
    }

    /* ========== SETTERS ========== */

    /// @notice set roots of merkle tree
    /// @param _games game IDs
    /// @param _roots new roots
    function setRootsPerGames(bytes32[] memory _games, bytes32[] memory _roots) external onlyWhitelistedAddresses {
        if (_games.length != _roots.length) revert InvalidLength();
        unchecked {
            for (uint i; i < _games.length; ++i) {
                _setRootForGame(_games[i], _roots[i]);
            }
        }
    }

    /// @notice set root of merkle tree
    /// @param _game game ID
    /// @param _root new root
    function setRootForGame(bytes32 _game, bytes32 _root) external onlyWhitelistedAddresses {
        _setRootForGame(_game, _root);
    }

    function _setRootForGame(bytes32 _game, bytes32 _root) internal {
        rootPerGame[_game] = _root;
        emit GameRootUpdated(_game, _root);
    }

    /// @notice sets main addresses
    /// @param _defaultCollateral the default token used for payment
    /// @param _manager manager address
    /// @param _riskManager risk manager address
    /// @param _resultManager result manager address
    /// @param _referrals referrals address
    /// @param _safeBox safeBox address
    function setAddresses(
        IERC20 _defaultCollateral,
        address _manager,
        address _riskManager,
        address _resultManager,
        address _referrals,
        address _safeBox
    ) external onlyOwner {
        _setAddresses(_defaultCollateral, _manager, _riskManager, _resultManager, _referrals, _safeBox);
    }

    function _setAddresses(
        IERC20 _defaultCollateral,
        address _manager,
        address _riskManager,
        address _resultManager,
        address _referrals,
        address _safeBox
    ) internal {
        defaultCollateral = _defaultCollateral;
        defaultCollateralDecimals = ISportsAMMV2Manager(address(defaultCollateral)).decimals();
        manager = ISportsAMMV2Manager(_manager);
        riskManager = ISportsAMMV2RiskManager(_riskManager);
        resultManager = ISportsAMMV2ResultManager(_resultManager);
        referrals = IReferrals(_referrals);
        safeBox = _safeBox;

        emit AddressesUpdated(_defaultCollateral, _manager, _riskManager, _resultManager, _referrals, _safeBox);
    }

    /**
     * @notice Sets the addresses of various betting processors.
     * @dev This function can only be called by the contract owner.
     * @param _liveTradingProcessor Address of the live trading processor contract.
     * @param _sgpTradingProcessor Address of the single-game parlay trading processor contract.
     * @param _freeBetsHolder Address of the free bets holder contract.
     */
    function setBettingProcessors(
        address _liveTradingProcessor,
        address _sgpTradingProcessor,
        address _freeBetsHolder
    ) external onlyOwner {
        liveTradingProcessor = _liveTradingProcessor;
        sgpTradingProcessor = _sgpTradingProcessor;
        freeBetsHolder = _freeBetsHolder;
        emit SetBettingProcessors(liveTradingProcessor, sgpTradingProcessor, freeBetsHolder);
    }

    /// @notice sets new Ticket Mastercopy address
    /// @param _ticketMastercopy new Ticket Mastercopy address
    function setTicketMastercopy(address _ticketMastercopy) external onlyOwner {
        ticketMastercopy = _ticketMastercopy;
        emit TicketMastercopyUpdated(_ticketMastercopy);
    }

    /// @notice sets multi-collateral on/off ramp contract and enable/disable
    /// @param _onOffRamper new multi-collateral on/off ramp address
    /// @param _enabled enable/disable multi-collateral on/off ramp
    function setMultiCollateralOnOffRamp(address _onOffRamper, bool _enabled) external onlyOwner {
        address prevOnOffRamp = address(multiCollateralOnOffRamp);

        if (prevOnOffRamp != address(0)) defaultCollateral.approve(prevOnOffRamp, 0);

        multiCollateralOnOffRamp = IMultiCollateralOnOffRamp(_onOffRamper);
        multicollateralEnabled = _enabled;

        if (_enabled && _onOffRamper != address(0)) defaultCollateral.approve(_onOffRamper, MAX_APPROVAL);

        emit SetMultiCollateralOnOffRamp(_onOffRamper, _enabled);
    }

    /// @notice sets different amounts
    /// @param _safeBoxFee safe box fee paid on each trade
    function setAmounts(uint _safeBoxFee) external onlyOwner {
        if (_safeBoxFee > 1e17) revert SafeBoxFeeTooHigh();
        safeBoxFee = _safeBoxFee;
        emit AmountsUpdated(_safeBoxFee);
    }

    /// @notice Sets parameters related to a collateral asset.
    /// @dev Only updates fields if the new value differs from the stored one.
    /// @param _collateral The collateral token address.
    /// @param _liquidityPool New liquidity pool address (optional, skip if same).
    /// @param _addedPayout New added payout percentage (optional, skip if same).
    /// @param _safeBox New dedicated SafeBox address (optional, skip if same).
    function configureCollateral(
        address _collateral,
        address _liquidityPool,
        uint _addedPayout,
        address _safeBox
    ) external onlyOwner {
        // Liquidity pool update
        if (liquidityPoolForCollateral[_collateral] != _liquidityPool) {
            address prevPool = liquidityPoolForCollateral[_collateral];
            if (prevPool != address(0)) {
                IERC20(_collateral).approve(prevPool, 0);
            }

            liquidityPoolForCollateral[_collateral] = _liquidityPool;

            if (_liquidityPool != address(0)) {
                IERC20(_collateral).approve(_liquidityPool, MAX_APPROVAL);
            }
        }

        // Added payout percentage update
        addedPayoutPercentagePerCollateral[_collateral] = _addedPayout;

        // SafeBox override update
        safeBoxPerCollateral[_collateral] = _safeBox;

        emit CollateralConfigured(_collateral, _liquidityPool, _addedPayout, _safeBox);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        if (!manager.isKnownTicket(_ticket)) revert UnknownTicket();
        _;
    }

    modifier onlyWhitelistedAddresses() {
        if (!(manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.ROOT_SETTING) || msg.sender == owner))
            revert InvalidSender();
        _;
    }

    modifier onlyValidRecipient(address _recipient) {
        if (_recipient == address(0)) revert UndefinedRecipient();
        _;
    }

    /* ========== EVENTS ========== */

    event NewTicket(Ticket.MarketData[] markets, address ticket, uint buyInAmount, uint payout, bool isLive);
    event TicketCreated(
        address ticket,
        address recipient,
        uint buyInAmount,
        uint fees,
        uint payout,
        uint totalQuote,
        address collateral
    );

    event TicketResolved(address ticket, address ticketOwner, bool isUserTheWinner);
    event ReferrerPaid(address refferer, address trader, uint amount, uint volume, address collateral);
    event SafeBoxFeePaid(uint safeBoxFee, uint safeBoxAmount, address collateral);

    event GameRootUpdated(bytes32 game, bytes32 root);
    event AmountsUpdated(uint safeBoxFee);
    event AddressesUpdated(
        IERC20 defaultCollateral,
        address manager,
        address riskManager,
        address resultManager,
        address referrals,
        address safeBox
    );
    event TicketMastercopyUpdated(address ticketMastercopy);
    event SetMultiCollateralOnOffRamp(address onOffRamper, bool enabled);
    event SetBettingProcessors(address liveTradingProcessor, address sgpTradingProcessor, address freeBetsHolder);
    event CollateralConfigured(address collateral, address liquidityPool, uint addedPayout, address safeBox);
}
