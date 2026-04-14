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
import "./SportsAMMV2Utils.sol";

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
    error OnlyDedicatedProcessor();
    error UndefinedRecipient();
    error UnknownTicket();
    error UnsupportedSender();
    error OfframpOnlyDefaultCollateralAllowed();
    error InsuffETHSent();
    error ZeroPriceForCollateral();
    error InsuffReceived();
    error InvalidLength();
    error InvalidSender();
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
    bool private multicollateralEnabled;

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
    address private stakingThalesBettingProxy;

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

    // the contract that can call cashout method
    address public cashoutProcessor;

    // utils contract for offloading code to reduce contract size
    SportsAMMV2Utils public sportsAMMV2Utils;

    // declare that it can receive eth
    receive() external payable {}

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the storage in the proxy contract with the parameters
    /// @param _owner owner for using the onlyOwner functions
    function initialize(address _owner) public initializer {
        setOwner(_owner);
        initNonReentrant();
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

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
        SportsAMMV2Utils.TradeQuoteCommonParams memory p = _buildTradeQuoteCommonParams(_collateral);
        (totalQuote, payout, fees, amountsToBuy, buyInAmountInDefaultCollateral, riskStatus) = sportsAMMV2Utils
            .tradeQuoteCommon(_tradeData, _buyInAmount, _collateral, _isLive, NON_SYSTEM_BET, p);
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
        SportsAMMV2Utils.TradeQuoteCommonParams memory p = _buildTradeQuoteCommonParams(_collateral);
        (totalQuote, payout, fees, amountsToBuy, buyInAmountInDefaultCollateral, riskStatus) = sportsAMMV2Utils
            .tradeQuoteCommon(_tradeData, _buyInAmount, _collateral, _isLive, _systemBetDenominator, p);
    }

    function _buildTradeQuoteCommonParams(
        address _collateral
    ) internal view returns (SportsAMMV2Utils.TradeQuoteCommonParams memory) {
        return
            SportsAMMV2Utils.TradeQuoteCommonParams(
                riskManager,
                ISportsAMMV2(address(this)),
                addedPayoutPercentagePerCollateral[_collateral],
                safeBoxFee,
                SportsAMMV2Utils.CollateralParams(
                    address(defaultCollateral),
                    defaultCollateralDecimals,
                    liquidityPoolForCollateral[_collateral],
                    multiCollateralOnOffRamp
                )
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
        address _collateral,
        bool _isLive
    ) external payable nonReentrant notPaused onlyValidRecipient(_recipient) returns (address _createdTicket) {
        if (msg.sender != sgpTradingProcessor) revert OnlyDedicatedProcessor();

        _createdTicket = _tradeInternal(
            _tradeData,
            TradeTypeData(NON_SYSTEM_BET, true, _isLive),
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
        if (_systemBetDenominator <= 1 || _systemBetDenominator >= _tradeData.length) revert SBDOutOfRange();
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
        if (msg.sender != liveTradingProcessor) revert OnlyDedicatedProcessor();

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
            _exerciseTicket(_ticket, address(0), true, false);
        } else if (action == ISportsAMMV2.TicketAction.MarkLost) {
            _exerciseTicket(_ticket, address(0), false, true);
        } else {
            _exerciseTicket(_ticket, address(0), false, false);
        }
    }

    /// @notice exercise specific ticket to an off ramp collateral
    /// @param _ticket ticket address
    /// @param _exerciseCollateral collateral address to off ramp to
    function exerciseTicketOffRamp(
        address _ticket,
        address _exerciseCollateral
    ) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        if (msg.sender != Ticket(_ticket).ticketOwner()) revert OnlyTicketOwner();
        _exerciseTicket(_ticket, _exerciseCollateral, false, false);
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
                if (ticketOwner != freeBetsHolder) {
                    Ticket(ticketAddress).expire(msg.sender);
                    manager.expireKnownTicket(ticketAddress, ticketOwner);
                }
            }
        }
    }

    // ============================
    // CASHOUT (quote-based) additions
    // ============================

    /**
     * @notice Cashout using approved per-leg odds & settled flags.
     * @param _ticket Ticket address.
     * @param approvedOddsPerLeg Approved per-leg implied probs (1e18).
     * @param isLegSettled Settled flags per leg (voided legs => true).
     * @param _recipient Recipient (must be ticket owner).
     */
    function cashoutTicketWithLegOdds(
        address _ticket,
        uint[] calldata approvedOddsPerLeg,
        bool[] calldata isLegSettled,
        address _recipient
    ) external nonReentrant notPaused onlyKnownTickets(_ticket) onlyValidRecipient(_recipient) returns (uint cashoutAmount) {
        if (msg.sender != cashoutProcessor) revert OnlyDedicatedProcessor();
        Ticket ticket = Ticket(_ticket);

        (, uint payoutAfterCashoutFee) = ticket.getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
        if (payoutAfterCashoutFee == 0) revert IllegalInputAmounts();

        // Try storing snapshot (new tickets support this, old ones don't)
        try ticket.setCashoutPerLegData(approvedOddsPerLeg, isLegSettled) {} catch {}

        cashoutAmount = ticket.cashout(payoutAfterCashoutFee, _recipient);

        IERC20 collateral = ticket.collateral();

        // protocol fees (safeBox/referrer), NOT cashout fee
        _handleFees(ticket.buyInAmount(), _recipient, collateral);

        _finalizeTicketResolution(_ticket, _recipient, collateral, true);

        emit TicketCashedOut(_ticket, _recipient, cashoutAmount);
    }

    function _finalizeTicketResolution(
        address _ticket,
        address _ticketOwner,
        IERC20 _collateral,
        bool _isUserTheWinner
    ) internal {
        manager.resolveKnownTicket(_ticket, _ticketOwner);
        emit TicketResolved(_ticket, _ticketOwner, _isUserTheWinner);

        // mark ticket as exercised in LiquidityPool and return any funds to the pool if ticket was lost or cancelled
        ISportsAMMV2LiquidityPool(liquidityPoolForCollateral[address(_collateral)]).transferToPool(
            _ticket,
            _collateral.balanceOf(address(this))
        );
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _handleCollateral(
        uint _buyInAmount,
        address _collateral,
        address _fromAddress,
        bool _isEth
    ) internal returns (address lqPool, uint collateralPrice, uint buyInAmount, address collateralAfterOnramp) {
        buyInAmount = _buyInAmount;

        // Default collateral path (including address(0) case)
        if (_collateral == address(0) || _collateral == address(defaultCollateral)) {
            collateralAfterOnramp = address(defaultCollateral);
            defaultCollateral.safeTransferFrom(_fromAddress, address(this), _buyInAmount);
        }
        // Non-default collateral path
        else {
            collateralAfterOnramp = _collateral;

            // Handle ETH or ERC20 transfer
            if (_isEth) {
                if (_collateral != multiCollateralOnOffRamp.WETH9() || msg.value < _buyInAmount) revert InsuffETHSent();
                IWeth(_collateral).deposit{value: msg.value}();
            } else {
                IERC20(_collateral).safeTransferFrom(_fromAddress, address(this), _buyInAmount);
            }

            // Check if direct liquidity pool exists for collateral
            lqPool = liquidityPoolForCollateral[_collateral];
            if (lqPool != address(0)) {
                collateralPrice = ISportsAMMV2LiquidityPool(lqPool).getCollateralPrice();
                if (collateralPrice == 0) revert ZeroPriceForCollateral();
            }
            // Handle onramping if no direct pool
            else {
                if (address(multiCollateralOnOffRamp) == address(0)) revert MultiCollatDisabled();

                IERC20(_collateral).approve(address(multiCollateralOnOffRamp), _buyInAmount);
                buyInAmount = multiCollateralOnOffRamp.onramp(_collateral, _buyInAmount);
                if (buyInAmount < multiCollateralOnOffRamp.getMinimumReceived(_collateral, _buyInAmount))
                    revert InsuffReceived();

                collateralAfterOnramp = address(defaultCollateral);
            }
        }

        // Get final liquidity pool
        lqPool = liquidityPoolForCollateral[collateralAfterOnramp];
    }

    function _trade(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeDataInternal memory _tradeDataInternal,
        uint8 _systemBetDenominator
    ) internal returns (address) {
        TradeProcessingParams memory processingParams;
        processingParams._addedPayoutPercentage = addedPayoutPercentagePerCollateral[_tradeDataInternal._collateral];

        {
            SportsAMMV2Utils.TradeProcessingResult memory result = sportsAMMV2Utils.calculateTradeQuote(
                _tradeData,
                SportsAMMV2Utils.CalculateTradeParams(
                    _tradeDataInternal._buyInAmount,
                    _tradeDataInternal._expectedPayout,
                    _tradeDataInternal._isLive,
                    _tradeDataInternal._isSGP,
                    processingParams._addedPayoutPercentage,
                    safeBoxFee
                ),
                _systemBetDenominator,
                SportsAMMV2Utils.TradeQuoteParams(
                    riskManager,
                    ISportsAMMV2(address(this)),
                    processingParams._addedPayoutPercentage,
                    safeBoxFee
                )
            );
            processingParams._totalQuote = result._totalQuote;
            processingParams._payout = result._payout;
            processingParams._fees = result._fees;
            processingParams._payoutWithFees = result._payoutWithFees;
            _tradeDataInternal._expectedPayout = result._expectedPayout;
        }

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

        // 1) Initialize the ticket (unchanged)
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

        // 2) Track ticket on the manager (unchanged)
        manager.addNewKnownTicket(_tradeData, address(ticket), _tradeDataInternal._recipient);

        // 3) Commit trade to LP (unchanged)
        ISportsAMMV2LiquidityPool(_tradeDataInternal._collateralPool).commitTrade(
            address(ticket),
            processingParams._payoutWithFees - _tradeDataInternal._buyInAmount
        );

        // 4) Fund the ticket with the full expected amount (unchanged)
        IERC20(_tradeDataInternal._collateral).safeTransfer(address(ticket), processingParams._payoutWithFees);

        // 5) Lock the accounting: tell the Ticket what the authoritative funded amount is
        ticket.setExpectedFinalPayout(processingParams._payoutWithFees);

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

    // Checks risk and updates Staking Volume
    function checkRisksLimits(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _totalQuote,
        uint _payout,
        TradeDataInternal memory _tradeDataInternal,
        uint8 _systemBetDenominator
    ) internal {
        (uint buyInAmountUSD, uint payoutUSD) = sportsAMMV2Utils.checkLimitsWithTransform(
            riskManager,
            _tradeDataInternal._buyInAmount,
            _totalQuote,
            _payout,
            _tradeDataInternal._expectedPayout,
            _tradeDataInternal._additionalSlippage,
            _tradeData.length,
            _tradeDataInternal._collateralPriceInUSD,
            _tradeDataInternal._collateral,
            defaultCollateralDecimals
        );
        riskManager.checkAndUpdateRisks(
            _tradeData,
            buyInAmountUSD,
            payoutUSD,
            _tradeDataInternal._isLive,
            _systemBetDenominator,
            _tradeDataInternal._isSGP
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

    function _handleFees(uint _buyInAmount, address _ticketOwner, IERC20 _collateral) internal returns (uint fees) {
        SportsAMMV2Utils.FeeResult memory feeResult = sportsAMMV2Utils.calculateFees(
            _buyInAmount,
            _ticketOwner,
            _collateral.balanceOf(address(this)),
            safeBoxFee,
            freeBetsHolder,
            safeBox,
            safeBoxPerCollateral[address(_collateral)],
            referrals
        );
        fees = feeResult.fees;

        if (feeResult.referrerShare > 0) {
            _collateral.safeTransfer(feeResult.referrer, feeResult.referrerShare);
            emit ReferrerPaid(feeResult.referrer, _ticketOwner, feeResult.referrerShare, _buyInAmount, address(_collateral));
        }
        if (feeResult.safeBoxAmount > 0) {
            _collateral.safeTransfer(feeResult.safeBoxTarget, feeResult.safeBoxAmount);
            emit SafeBoxFeePaid(safeBoxFee, feeResult.safeBoxAmount, address(_collateral));
        }
    }

    function _divWithDecimals(uint _dividend, uint _divisor) internal pure returns (uint) {
        return (ONE * _dividend) / _divisor;
    }

    function _mulWithDecimals(uint _firstMul, uint _secondMul) internal pure returns (uint) {
        return (_firstMul * _secondMul) / ONE;
    }

    function _setReferrer(address _referrer, address _recipient) internal {
        if (_referrer != address(0) && _recipient != address(freeBetsHolder)) referrals.setReferrer(_referrer, _recipient);
    }

    function _exerciseTicket(address _ticket, address _exerciseCollateral, bool _cancelTicket, bool _markLost) internal {
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

        if (ticketOwner == freeBetsHolder) {
            IProxyBetting(ticketOwner).confirmTicketResolved(_ticket);
        }
        if (!ticket.cancelled()) {
            _handleFees(ticket.buyInAmount(), ticketOwner, ticketCollateral);
        }

        if (userWonAmount > 0 && _exerciseCollateral != address(0) && _exerciseCollateral != address(ticketCollateral)) {
            if (ticketCollateral != defaultCollateral) revert OfframpOnlyDefaultCollateralAllowed();

            IERC20(_exerciseCollateral).safeTransfer(
                ticketOwner,
                multiCollateralOnOffRamp.offramp(_exerciseCollateral, userWonAmount)
            );
        }

        _finalizeTicketResolution(_ticket, ticketOwner, ticketCollateral, ticket.isUserTheWinner());
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
     * @param _cashoutProcessor Address of cashout processor contract.
     */
    function setBettingProcessors(
        address _liveTradingProcessor,
        address _sgpTradingProcessor,
        address _freeBetsHolder,
        address _cashoutProcessor
    ) external onlyOwner {
        liveTradingProcessor = _liveTradingProcessor;
        sgpTradingProcessor = _sgpTradingProcessor;
        freeBetsHolder = _freeBetsHolder;
        cashoutProcessor = _cashoutProcessor;
        emit SetBettingProcessors(liveTradingProcessor, sgpTradingProcessor, freeBetsHolder, cashoutProcessor);
    }

    /// @notice sets new Ticket Mastercopy address
    /// @param _ticketMastercopy new Ticket Mastercopy address
    function setTicketMastercopy(address _ticketMastercopy) external onlyOwner {
        ticketMastercopy = _ticketMastercopy;
        emit TicketMastercopyUpdated(_ticketMastercopy);
    }

    /// @notice sets multi-collateral on/off ramp contract and enable/disable
    /// @param _onOffRamper new multi-collateral on/off ramp address
    function setMultiCollateralOnOffRamp(address _onOffRamper) external onlyOwner {
        _updateApproval(defaultCollateral, address(multiCollateralOnOffRamp), _onOffRamper);
        multiCollateralOnOffRamp = IMultiCollateralOnOffRamp(_onOffRamper);
        emit SetMultiCollateralOnOffRamp(_onOffRamper);
    }

    /// @notice sets different amounts
    /// @param _safeBoxFee safe box fee paid on each trade
    function setAmounts(uint _safeBoxFee) external onlyOwner {
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
            _updateApproval(IERC20(_collateral), liquidityPoolForCollateral[_collateral], _liquidityPool);
            liquidityPoolForCollateral[_collateral] = _liquidityPool;
        }

        // Added payout percentage update
        addedPayoutPercentagePerCollateral[_collateral] = _addedPayout;

        // SafeBox override update
        safeBoxPerCollateral[_collateral] = _safeBox;

        emit CollateralConfigured(_collateral, _liquidityPool, _addedPayout, _safeBox);
    }

    /// @notice sets the SportsAMMV2Utils contract address
    /// @param _sportsAMMV2Utils new SportsAMMV2Utils address
    function setSportsAMMV2Utils(address _sportsAMMV2Utils) external onlyOwner {
        sportsAMMV2Utils = SportsAMMV2Utils(_sportsAMMV2Utils);
        emit SetSportsAMMV2Utils(_sportsAMMV2Utils);
    }

    function _updateApproval(IERC20 token, address oldSpender, address newSpender) internal {
        if (oldSpender != address(0)) {
            token.approve(oldSpender, 0);
        }

        if (newSpender != address(0)) {
            token.approve(newSpender, MAX_APPROVAL);
        }
    }

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        if (!manager.isKnownTicket(_ticket)) revert UnknownTicket();
        _;
    }

    modifier onlyWhitelistedAddresses() {
        if (!manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.ROOT_SETTING) && msg.sender != owner)
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
    event SetMultiCollateralOnOffRamp(address onOffRamper);
    event SetBettingProcessors(
        address liveTradingProcessor,
        address sgpTradingProcessor,
        address freeBetsHolder,
        address cashoutProcessor
    );
    event CollateralConfigured(address collateral, address liquidityPool, uint addedPayout, address safeBox);
    event TicketCashedOut(address indexed ticket, address indexed recipient, uint cashoutAmount);
    event SetSportsAMMV2Utils(address sportsAMMV2Utils);
}
