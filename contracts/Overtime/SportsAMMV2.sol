// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../utils/libraries/AddressSetLib.sol";

import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";

import "./Ticket.sol";
import "../interfaces/ISportsAMMV2.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2ResultManager.sol";
import "../interfaces/ISportsAMMV2LiquidityPool.sol";
import "../interfaces/ICollateralUtility.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== LIBRARIES ========== */

    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

    /* ========== CONST VARIABLES ========== */

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;

    /* ========== STATE VARIABLES ========== */

    // merkle tree root per game
    mapping(bytes32 => bytes32) public rootPerGame;

    // the default token used for payment
    IERC20 public defaultCollateral;

    // manager address
    ISportsAMMV2Manager public manager;

    // risk manager address
    ISportsAMMV2RiskManager public riskManager;

    // risk manager address
    ISportsAMMV2ResultManager public resultManager;

    // referrals address
    IReferrals public referrals;

    // ticket mastercopy address
    address public ticketMastercopy;

    // safe box address
    address public safeBox;

    // safe box fee paid on each trade
    uint public safeBoxFee;

    // safe box fee per specific address paid on each trade
    mapping(address => uint) public safeBoxFeePerAddress;

    // minimum ticket buy-in amount
    uint public minBuyInAmount;

    // maximum ticket size
    uint public maxTicketSize;

    // maximum supported payout amount
    uint public maxSupportedAmount;

    // maximum supported ticket odds
    uint public maxSupportedOdds;

    // stores active tickets
    AddressSetLib.AddressSet internal knownTickets;

    // multi-collateral on/off ramp address
    IMultiCollateralOnOffRamp public multiCollateralOnOffRamp;

    // is multi-collateral enabled
    bool public multicollateralEnabled;

    // stores current risk per market type and position, defined with gameId -> typeId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => int)))) public riskPerMarketTypeAndPosition;

    // the period of time in seconds before a market is matured and begins to be restricted for AMM trading
    uint public minimalTimeLeftToMaturity;

    // the period of time in seconds after mauturity when ticket expires
    uint public expiryDuration;

    // liquidity pool address
    ISportsAMMV2LiquidityPool public liquidityPool;

    // staking thales address
    IStakingThales public stakingThales;

    // spent on game (parent market together with all child markets)
    mapping(bytes32 => uint) public spentOnGame;

    // stores active tickets per user
    mapping(address => AddressSetLib.AddressSet) internal activeTicketsPerUser;

    // stores resolved tickets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedTicketsPerUser;

    // stores tickets per game
    mapping(bytes32 => AddressSetLib.AddressSet) internal ticketsPerGame;

    address public liveTradingProcessor;

    struct TradeDataInternal {
        uint _buyInAmount;
        uint _expectedPayout;
        uint _additionalSlippage;
        address _differentRecipient;
        bool _isLive;
        address _requester;
        address _collateral;
        address _collateralPool;
        uint _collateralPriceInUSD;
    }

    mapping(address => address) public collateralPool;

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the storage in the proxy contract with the parameters
    /// @param _owner owner for using the onlyOwner functions
    /// @param _defaultCollateral the address of default token used for payment
    /// @param _manager the address of manager
    /// @param _riskManager the address of risk manager
    /// @param _referrals the address of referrals
    /// @param _stakingThales the address of staking thales
    /// @param _safeBox the address of safe box
    function initialize(
        address _owner,
        IERC20 _defaultCollateral,
        ISportsAMMV2Manager _manager,
        ISportsAMMV2RiskManager _riskManager,
        ISportsAMMV2ResultManager _resultManager,
        IReferrals _referrals,
        IStakingThales _stakingThales,
        address _safeBox
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        defaultCollateral = _defaultCollateral;
        manager = _manager;
        riskManager = _riskManager;
        resultManager = _resultManager;
        referrals = _referrals;
        stakingThales = _stakingThales;
        safeBox = _safeBox;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice gets trade quote
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _collateral different collateral used for payment
    /// @return totalQuote total ticket quote
    /// @return payout expected payout
    /// @return fees ticket fees
    /// @return finalQuotes final quotes per market
    /// @return amountsToBuy amounts per market
    /// @return collateralQuote buy-in amount in different collateral
    function tradeQuote(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        address _collateral
    )
        external
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory finalQuotes,
            uint[] memory amountsToBuy,
            uint collateralQuote
        )
    {
        (totalQuote, payout, fees, finalQuotes, amountsToBuy) = _tradeQuote(_tradeData, _buyInAmount, true);

        collateralQuote = _collateral == address(0)
            ? _buyInAmount
            : multiCollateralOnOffRamp.getMinimumNeeded(_collateral, _buyInAmount);
    }

    /// @notice is provided ticket active
    /// @param _ticket ticket address
    /// @return isActiveTicket true/false
    function isActiveTicket(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    /// @notice gets batch of active tickets
    /// @param _index start index
    /// @param _pageSize batch size
    /// @return activeTickets
    function getActiveTickets(uint _index, uint _pageSize) external view returns (address[] memory) {
        return knownTickets.getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets
    /// @return numOfActiveTickets
    function numOfActiveTickets() external view returns (uint) {
        return knownTickets.elements.length;
    }

    /// @notice gets batch of active tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active tickets for
    /// @return activeTickets
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return activeTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets per user
    /// @param _user to get number of active tickets for
    /// @return numOfActiveTickets
    function numOfActiveTicketsPerUser(address _user) external view returns (uint) {
        return activeTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of resolved tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved tickets for
    /// @return resolvedTickets
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return resolvedTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of resolved tickets per user
    /// @param _user to get number of resolved tickets for
    /// @return numOfResolvedTickets
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint) {
        return resolvedTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of tickets per game
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _gameId to get tickets for
    /// @return resolvedTickets
    function getTicketsPerGame(uint _index, uint _pageSize, bytes32 _gameId) external view returns (address[] memory) {
        return ticketsPerGame[_gameId].getPage(_index, _pageSize);
    }

    /// @notice gets number of tickets per game
    /// @param _gameId to get number of tickets for
    /// @return numOfTickets
    function numOfTicketsPerGame(bytes32 _gameId) external view returns (uint) {
        return ticketsPerGame[_gameId].elements.length;
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice make a trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedPayout expected payout got from quote method
    /// @param _additionalSlippage slippage tolerance
    /// @param _differentRecipient different recipent of the ticket
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    function trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address _collateral
    ) external payable nonReentrant notPaused {
        address useLPpool;
        uint collateralPriceInUSD;
        if (_referrer != address(0)) {
            referrals.setReferrer(_referrer, msg.sender);
        }

        if (_differentRecipient == address(0)) {
            _differentRecipient = msg.sender;
        }

        if (_collateral != address(0)) {
            (useLPpool, collateralPriceInUSD) = _handleDifferentCollateral(_buyInAmount, _collateral, msg.sender);
        }
        if (useLPpool != address(0)) {
            _trade(
                _tradeData,
                TradeDataInternal(
                    _buyInAmount,
                    _expectedPayout,
                    _additionalSlippage,
                    _differentRecipient,
                    false,
                    msg.sender,
                    _collateral,
                    useLPpool,
                    collateralPriceInUSD
                    // (ONE-ISportsAMMV2Manager(address(defaultCollateral)).decimals())
                )
            );
        } else {
            _trade(
                _tradeData,
                TradeDataInternal(
                    _buyInAmount,
                    _expectedPayout,
                    _additionalSlippage,
                    _differentRecipient,
                    false,
                    msg.sender,
                    address(0),
                    address(0),
                    0
                )
            );
        }
    }

    /// @notice make a live trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedPayout expected payout got from LiveTradingProcessor method
    /// @param _differentRecipient different recipient of the ticket
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    function tradeLive(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        address _requester,
        uint _buyInAmount,
        uint _expectedPayout,
        address _differentRecipient,
        address _referrer,
        address _collateral
    ) external payable nonReentrant notPaused {
        require(msg.sender == liveTradingProcessor, "Only Live");

        if (_referrer != address(0)) {
            referrals.setReferrer(_referrer, _requester);
        }

        require(_differentRecipient != address(0), "undef Recip");
        address useLPpool;
        uint collateralPriceInUSD;
        if (_collateral != address(0)) {
            (useLPpool, collateralPriceInUSD) = _handleDifferentCollateral(_buyInAmount, _collateral, msg.sender);
        }

        if (useLPpool != address(0)) {
            _trade(
                _tradeData,
                TradeDataInternal(
                    _buyInAmount,
                    _expectedPayout,
                    0, // no additional slippage allowed as the amount comes from the LiveTradingProcessor
                    _differentRecipient,
                    true,
                    _requester,
                    _collateral,
                    useLPpool,
                    collateralPriceInUSD
                    // (ONE-ISportsAMMV2Manager(address(defaultCollateral)).decimals())
                )
            );
        } else {
            _trade(
                _tradeData,
                TradeDataInternal(
                    _buyInAmount,
                    _expectedPayout,
                    0, // no additional slippage allowed as the amount comes from the LiveTradingProcessor
                    _differentRecipient,
                    true,
                    _requester,
                    address(0),
                    address(0),
                    0
                )
            );
        }
    }

    /// @notice exercise specific ticket
    /// @param _ticket ticket address
    function exerciseTicket(address _ticket) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        _exerciseTicket(_ticket);
    }

    /// @notice additional logic for ticket resolve (called only from ticket contact)
    /// @param _ticketOwner ticket owner
    /// @param _hasUserWon is winning ticket
    /// @param _cancelled is ticket cancelled (needed for referral and safe box fee)
    /// @param _buyInAmount ticket buy-in amount (needed for referral and safe box fee)
    /// @param _ticketCreator ticket creator (needed for referral and safe box fee)
    function resolveTicket(
        address _ticketOwner,
        bool _hasUserWon,
        bool _cancelled,
        uint _buyInAmount,
        address _ticketCreator,
        address _collateral
    ) external notPaused onlyKnownTickets(msg.sender) {
        if (!_cancelled) {
            _handleReferrerAndSB(_buyInAmount, _ticketCreator, _collateral);
        }
        knownTickets.remove(msg.sender);
        if (activeTicketsPerUser[_ticketOwner].contains(msg.sender)) {
            activeTicketsPerUser[_ticketOwner].remove(msg.sender);
        }
        resolvedTicketsPerUser[_ticketOwner].add(msg.sender);
        emit TicketResolved(msg.sender, _ticketOwner, _hasUserWon);
    }

    /// @notice pause/unapause provided tickets
    /// @param _tickets array of tickets to be paused/unpaused
    /// @param _paused pause/unpause
    function setPausedTickets(address[] calldata _tickets, bool _paused) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            Ticket(_tickets[i]).setPaused(_paused);
        }
    }

    /// @notice expire provided tickets
    /// @param _tickets array of tickets to be expired
    function expireTickets(address[] calldata _tickets) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            if (Ticket(_tickets[i]).phase() == Ticket.Phase.Expiry) {
                Ticket(_tickets[i]).expire(payable(safeBox));
            }
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _tradeQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount,
        bool _shouldCheckRisk
    )
        internal
        view
        returns (uint totalQuote, uint payout, uint fees, uint[] memory finalQuotes, uint[] memory amountsToBuy)
    {
        uint numOfMarkets = _tradeData.length;
        finalQuotes = new uint[](numOfMarkets);
        amountsToBuy = new uint[](numOfMarkets);

        for (uint i = 0; i < numOfMarkets; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            _verifyMerkleTree(marketTradeData);

            if (marketTradeData.odds.length > marketTradeData.position) {
                finalQuotes[i] = marketTradeData.odds[marketTradeData.position];
            }
            if (finalQuotes[i] == 0) {
                totalQuote = 0;
                break;
            }
            amountsToBuy[i] = (ONE * _buyInAmount) / finalQuotes[i];
            totalQuote = totalQuote == 0 ? finalQuotes[i] : (totalQuote * finalQuotes[i]) / ONE;
        }
        if (totalQuote != 0) {
            if (totalQuote < maxSupportedOdds) {
                totalQuote = maxSupportedOdds;
            }
            payout = (_buyInAmount * ONE) / totalQuote;
            fees = (safeBoxFee * _buyInAmount) / ONE;

            if (_shouldCheckRisk) {
                for (uint i = 0; i < _tradeData.length; i++) {
                    if (amountsToBuy[i] > _buyInAmount) {
                        ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

                        uint marketRiskAmount = amountsToBuy[i] - _buyInAmount;
                        if (
                            riskPerMarketTypeAndPosition[marketTradeData.gameId][marketTradeData.typeId][
                                marketTradeData.playerId
                            ][marketTradeData.position] +
                                int256(marketRiskAmount) >
                            int256(
                                riskManager.calculateCapToBeUsed(
                                    marketTradeData.gameId,
                                    marketTradeData.sportId,
                                    marketTradeData.typeId,
                                    marketTradeData.playerId,
                                    marketTradeData.line,
                                    marketTradeData.maturity
                                )
                            ) ||
                            !riskManager.isTotalSpendingLessThanTotalRisk(
                                spentOnGame[marketTradeData.gameId] + marketRiskAmount,
                                marketTradeData.gameId,
                                marketTradeData.sportId,
                                marketTradeData.typeId,
                                marketTradeData.playerId,
                                marketTradeData.line,
                                marketTradeData.maturity
                            )
                        ) {
                            totalQuote = 0;
                            finalQuotes[i] = 0;
                            amountsToBuy[i] = 0;
                        }
                    }
                }
            }
        }

        if (_shouldCheckRisk && riskManager.hasIllegalCombinationsOnTicket(_tradeData)) {
            totalQuote = 0;
        }
    }

    function _handleDifferentCollateral(
        uint _buyInAmount,
        address _collateral,
        address _fromAddress
    ) internal returns (address lpPool, uint ethUsdPrice) {
        require(multicollateralEnabled, "Multi-collat not enabled");
        uint exactReceived;
        lpPool = collateralPool[_collateral];
        if (lpPool != address(0)) {
            if (_collateral == multiCollateralOnOffRamp.WETH9()) {
                // WETH specific case
                require(msg.value >= _buyInAmount, "Insuff ETH sent");
                uint balanceBefore = IERC20(_collateral).balanceOf(address(this));
                ICollateralUtility(_collateral).deposit{value: msg.value}();
                uint balanceDiff = IERC20(_collateral).balanceOf(address(this)) - balanceBefore;
                require(balanceDiff == msg.value, "Insuff WETH");
                ethUsdPrice = ICollateralUtility(ICollateralUtility(address(multiCollateralOnOffRamp)).priceFeed())
                    .rateForCurrency("ETH");
                exactReceived = balanceDiff;
            } else {
                // Generic case
                IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _buyInAmount);
                exactReceived = _buyInAmount;
            }
        } else {
            uint collateralQuote = multiCollateralOnOffRamp.getMinimumNeeded(_collateral, _buyInAmount);
            IERC20(_collateral).safeTransferFrom(_fromAddress, address(this), collateralQuote);
            IERC20(_collateral).approve(address(multiCollateralOnOffRamp), collateralQuote);
            exactReceived = multiCollateralOnOffRamp.onramp(_collateral, collateralQuote);
        }

        require(exactReceived >= _buyInAmount, "Insuff payment");

        //send the surplus to SB
        if (exactReceived > _buyInAmount) {
            if (lpPool != address(0)) {
                // TODO: if needed add the logic to convert the surplus to default collateral and send to safeBox
                IERC20(_collateral).safeTransfer(safeBox, exactReceived - _buyInAmount);
            } else {
                defaultCollateral.safeTransfer(safeBox, exactReceived - _buyInAmount);
            }
        }
    }

    function _trade(ISportsAMMV2.TradeData[] memory _tradeData, TradeDataInternal memory _tradeDataInternal) internal {
        uint totalQuote = (ONE * _tradeDataInternal._buyInAmount) / _tradeDataInternal._expectedPayout;
        uint payout = _tradeDataInternal._expectedPayout;
        //TODO: include this in the tradeQuote method for live trading
        uint fees = (safeBoxFee * _tradeDataInternal._buyInAmount) / ONE;
        uint[] memory amountsToBuy = new uint[](_tradeData.length);
        if (!_tradeDataInternal._isLive) {
            (totalQuote, payout, fees, , amountsToBuy) = _tradeQuote(_tradeData, _tradeDataInternal._buyInAmount, false);
        } else {
            amountsToBuy[0] = payout;
        }

        uint payoutWithFees = payout + fees;
        uint transformDecimal = (18 - ISportsAMMV2Manager(address(defaultCollateral)).decimals());
        if (_tradeDataInternal._collateral == address(0)) {
            _checkLimits(
                _tradeDataInternal._buyInAmount,
                totalQuote,
                payout,
                _tradeDataInternal._expectedPayout,
                _tradeDataInternal._additionalSlippage
            );
            _checkRisk(_tradeData, amountsToBuy, _tradeDataInternal._buyInAmount);
            defaultCollateral.safeTransferFrom(
                _tradeDataInternal._requester,
                address(this),
                _tradeDataInternal._buyInAmount
            );
        } else {
            amountsToBuy = _transformAmountsToUSD(amountsToBuy, _tradeDataInternal._collateralPriceInUSD, transformDecimal);
            _checkLimits(
                _transformToUSD(_tradeDataInternal._buyInAmount, _tradeDataInternal._collateralPriceInUSD, transformDecimal),
                totalQuote,
                _transformToUSD(payout, _tradeDataInternal._collateralPriceInUSD, transformDecimal),
                _transformToUSD(
                    _tradeDataInternal._expectedPayout,
                    _tradeDataInternal._collateralPriceInUSD,
                    transformDecimal
                ),
                _tradeDataInternal._additionalSlippage
            );
            _checkRisk(
                _tradeData,
                amountsToBuy,
                _transformToUSD(_tradeDataInternal._buyInAmount, _tradeDataInternal._collateralPriceInUSD, transformDecimal)
            );
        }

        // clone a ticket
        Ticket.MarketData[] memory markets = _getTicketMarkets(_tradeData);
        Ticket ticket = Ticket(Clones.clone(ticketMastercopy));

        ticket.initialize(
            Ticket.TicketInit(
                markets,
                _tradeDataInternal._buyInAmount,
                fees,
                totalQuote,
                address(this),
                _tradeDataInternal._differentRecipient,
                msg.sender,
                _tradeDataInternal._collateral == address(0) ? defaultCollateral : IERC20(_tradeDataInternal._collateral),
                (block.timestamp + expiryDuration)
            )
        );
        _saveTicketData(_tradeData, address(ticket), _tradeDataInternal._differentRecipient);

        if (_tradeDataInternal._collateral == address(0)) {
            if (address(stakingThales) != address(0)) {
                stakingThales.updateVolume(_tradeDataInternal._differentRecipient, _tradeDataInternal._buyInAmount);
            }
            liquidityPool.commitTrade(address(ticket), payoutWithFees - _tradeDataInternal._buyInAmount);
            defaultCollateral.safeTransfer(address(ticket), payoutWithFees);
        } else {
            if (address(stakingThales) != address(0)) {
                stakingThales.updateVolume(
                    _tradeDataInternal._differentRecipient,
                    _transformToUSD(
                        _tradeDataInternal._buyInAmount,
                        _tradeDataInternal._collateralPriceInUSD,
                        transformDecimal
                    )
                );
            }
            ISportsAMMV2LiquidityPool(_tradeDataInternal._collateralPool).commitTrade(
                address(ticket),
                payoutWithFees - _tradeDataInternal._buyInAmount
            );
            IERC20(_tradeDataInternal._collateral).safeTransfer(address(ticket), payoutWithFees);
        }

        emit NewTicket(markets, address(ticket), _tradeDataInternal._buyInAmount, payout);
        emit TicketCreated(
            address(ticket),
            _tradeDataInternal._differentRecipient,
            _tradeDataInternal._buyInAmount,
            fees,
            payout,
            totalQuote
        );
    }

    function _transformToUSD(
        uint _amountInCollateral,
        uint _collateralPriceInUSD,
        uint _defaultCollateralDecimalConverter
    ) internal pure returns (uint amountInUSD) {
        if (_defaultCollateralDecimalConverter > 0) {
            amountInUSD = (_amountInCollateral * _collateralPriceInUSD) / (ONE * 10 ** _defaultCollateralDecimalConverter);
        } else {
            amountInUSD = (_amountInCollateral * _collateralPriceInUSD) / ONE;
        }
    }

    function _transformAmountsToUSD(
        uint[] memory _amountInCollateral,
        uint _collateralPriceInUSD,
        uint _defaultCollateralDecimalConverter
    ) internal pure returns (uint[] memory amountsInUSD) {
        amountsInUSD = new uint[](_amountInCollateral.length);
        for (uint i = 0; i < _amountInCollateral.length; i++) {
            amountsInUSD[i] = _transformToUSD(
                _amountInCollateral[i],
                _collateralPriceInUSD,
                _defaultCollateralDecimalConverter
            );
        }
    }

    function _saveTicketData(ISportsAMMV2.TradeData[] memory _tradeData, address ticket, address user) internal {
        knownTickets.add(ticket);
        activeTicketsPerUser[user].add(ticket);

        for (uint i = 0; i < _tradeData.length; i++) {
            ticketsPerGame[_tradeData[i].gameId].add(ticket);
        }
    }

    function _getTicketMarkets(
        ISportsAMMV2.TradeData[] memory _tradeData
    ) internal pure returns (Ticket.MarketData[] memory markets) {
        markets = new Ticket.MarketData[](_tradeData.length);

        for (uint i = 0; i < _tradeData.length; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            markets[i] = Ticket.MarketData(
                marketTradeData.gameId,
                marketTradeData.sportId,
                marketTradeData.typeId,
                marketTradeData.maturity,
                marketTradeData.status,
                marketTradeData.line,
                marketTradeData.playerId,
                marketTradeData.position,
                marketTradeData.odds[marketTradeData.position],
                marketTradeData.combinedPositions[marketTradeData.position]
            );
        }
    }

    function _checkLimits(
        uint _buyInAmount,
        uint _totalQuote,
        uint _payout,
        uint _expectedPayout,
        uint _additionalSlippage
    ) internal view {
        // apply all checks
        require(_buyInAmount >= minBuyInAmount, "Low buy-in");
        require(_totalQuote >= maxSupportedOdds, "Exceed max odds");
        require((_payout - _buyInAmount) <= maxSupportedAmount, "Exceed max amount");
        require(((ONE * _expectedPayout) / _payout) <= (ONE + _additionalSlippage), "Slippage too high");
    }

    function _checkRisk(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint[] memory _amountsToBuy,
        uint _buyInAmount
    ) internal {
        for (uint i = 0; i < _tradeData.length; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];
            bytes32 gameId = marketTradeData.gameId;
            uint16 sportId = marketTradeData.sportId;
            uint16 typeId = marketTradeData.typeId;
            uint maturity = marketTradeData.maturity;
            int24 line = marketTradeData.line;
            uint16 playerId = marketTradeData.playerId;
            uint[] memory odds = marketTradeData.odds;
            uint8 position = marketTradeData.position;

            require(_isMarketInAMMTrading(marketTradeData), "Not trading");
            require(odds.length > position, "Invalid position");

            if (_amountsToBuy[i] > _buyInAmount) {
                uint marketRiskAmount = _amountsToBuy[i] - _buyInAmount;

                int currentRiskPerMarketTypeAndPosition = riskPerMarketTypeAndPosition[gameId][typeId][playerId][position];
                for (uint j = 0; j < odds.length; j++) {
                    if (j == position) {
                        riskPerMarketTypeAndPosition[gameId][typeId][playerId][j] =
                            currentRiskPerMarketTypeAndPosition +
                            int256(marketRiskAmount);
                    } else {
                        riskPerMarketTypeAndPosition[gameId][typeId][playerId][j] =
                            currentRiskPerMarketTypeAndPosition -
                            int256(marketRiskAmount);
                    }
                }
                spentOnGame[gameId] += marketRiskAmount;

                require(
                    currentRiskPerMarketTypeAndPosition <
                        int256(riskManager.calculateCapToBeUsed(gameId, sportId, typeId, playerId, line, maturity)),
                    "Risk exceeded"
                );
                require(
                    riskManager.isTotalSpendingLessThanTotalRisk(
                        spentOnGame[gameId],
                        gameId,
                        sportId,
                        typeId,
                        playerId,
                        line,
                        maturity
                    ),
                    "Risk is to high"
                );
            }
            require(!riskManager.hasIllegalCombinationsOnTicket(_tradeData), "Illegal combination detected");
        }
    }

    function _isMarketInAMMTrading(ISportsAMMV2.TradeData memory tradeData) internal view returns (bool isTrading) {
        bool isResolved = resultManager.isMarketResolved(
            tradeData.gameId,
            tradeData.typeId,
            tradeData.playerId,
            tradeData.line,
            tradeData.combinedPositions[tradeData.position]
        );
        if (tradeData.status == 0 && !isResolved) {
            if (tradeData.maturity >= block.timestamp) {
                isTrading = (tradeData.maturity - block.timestamp) > minimalTimeLeftToMaturity;
            }
        }
    }

    function _handleReferrerAndSB(
        uint _buyInAmount,
        address _tickerCreator,
        address _collateral
    ) internal returns (uint safeBoxAmount) {
        uint referrerShare;
        address referrer = referrals.sportReferrals(_tickerCreator);
        IERC20 useCollateral = IERC20(_collateral);
        if (referrer != address(0)) {
            uint referrerFeeByTier = referrals.getReferrerFee(referrer);
            if (referrerFeeByTier > 0) {
                referrerShare = (_buyInAmount * referrerFeeByTier) / ONE;
                useCollateral.safeTransfer(referrer, referrerShare);
                emit ReferrerPaid(referrer, _tickerCreator, referrerShare, _buyInAmount);
            }
        }
        safeBoxAmount = _getSafeBoxAmount(_buyInAmount, _tickerCreator);
        useCollateral.safeTransfer(safeBox, safeBoxAmount - referrerShare);
        emit SafeBoxFeePaid(safeBoxFee, safeBoxAmount);
    }

    function _getSafeBoxAmount(uint _buyInAmount, address _toCheck) internal view returns (uint safeBoxAmount) {
        uint sbFee = _getSafeBoxFeePerAddress(_toCheck);
        safeBoxAmount = (_buyInAmount * sbFee) / ONE;
    }

    function _getSafeBoxFeePerAddress(address _toCheck) internal view returns (uint toReturn) {
        return safeBoxFeePerAddress[_toCheck] > 0 ? safeBoxFeePerAddress[_toCheck] : safeBoxFee;
    }

    function _verifyMerkleTree(ISportsAMMV2.TradeData memory marketTradeData) internal view {
        // Compute the merkle leaf from trade data
        bytes memory encodePackedOutput = abi.encodePacked(
            marketTradeData.gameId,
            uint(marketTradeData.sportId),
            uint(marketTradeData.typeId),
            marketTradeData.maturity,
            uint(marketTradeData.status),
            int(marketTradeData.line),
            uint(marketTradeData.playerId),
            marketTradeData.odds
        );

        for (uint i; i < marketTradeData.combinedPositions.length; i++) {
            for (uint j; j < marketTradeData.combinedPositions[i].length; j++) {
                encodePackedOutput = abi.encodePacked(
                    encodePackedOutput,
                    uint(marketTradeData.combinedPositions[i][j].typeId),
                    uint(marketTradeData.combinedPositions[i][j].position),
                    int(marketTradeData.combinedPositions[i][j].line)
                );
            }
        }

        bytes32 leaf = keccak256(encodePackedOutput);
        // verify the proof is valid
        require(
            MerkleProof.verify(marketTradeData.merkleProof, rootPerGame[marketTradeData.gameId], leaf),
            "Proof is not valid"
        );
    }

    function _exerciseTicket(address _ticket) internal {
        Ticket ticket = Ticket(_ticket);
        ticket.exercise();
        IERC20 ticketCollateral = ticket.collateral();
        uint amount = ticketCollateral.balanceOf(address(this));
        if (amount > 0) {
            ISportsAMMV2LiquidityPool(collateralPool[address(ticketCollateral)]).transferToPool(_ticket, amount);
            // Note: Following code can be used in case:
            // the default collateral is not added to the collateralPool mapping.
            // In test and production, it safer to add it.
            // address usePool = collateralPool[address(ticketCollateral)];
            // if(usePool != address(0)) {
            //     ISportsAMMV2LiquidityPool(collateralPool[address(ticketCollateral)]).transferToPool(_ticket, amount);
            // } else {
            //     liquidityPool.transferToPool(_ticket, amount);
            // }
        }
    }

    /* ========== SETTERS ========== */

    /// @notice set roots of merkle tree
    /// @param _games game IDs
    /// @param _roots new roots
    function setRootsPerGames(bytes32[] memory _games, bytes32[] memory _roots) public onlyWhitelistedAddresses(msg.sender) {
        require(_games.length == _roots.length, "Invalid length");
        for (uint i; i < _games.length; i++) {
            rootPerGame[_games[i]] = _roots[i];
            emit GameRootUpdated(_games[i], _roots[i]);
        }
    }

    /// @notice sets different amounts
    /// @param _safeBoxFee safe box fee paid on each trade
    /// @param _minBuyInAmount minimum ticket buy-in amount
    /// @param _maxTicketSize maximum ticket size
    /// @param _maxSupportedAmount maximum supported payout amount
    /// @param _maxSupportedOdds  maximum supported ticket odds
    function setAmounts(
        uint _safeBoxFee,
        uint _minBuyInAmount,
        uint _maxTicketSize,
        uint _maxSupportedAmount,
        uint _maxSupportedOdds
    ) external onlyOwner {
        safeBoxFee = _safeBoxFee;
        minBuyInAmount = _minBuyInAmount;
        maxTicketSize = _maxTicketSize;
        maxSupportedAmount = _maxSupportedAmount;
        maxSupportedOdds = _maxSupportedOdds;
        emit AmountsUpdated(_safeBoxFee, _minBuyInAmount, _maxTicketSize, _maxSupportedAmount, _maxSupportedOdds);
    }

    /// @notice sets main addresses
    /// @param _defaultCollateral the default token used for payment
    /// @param _manager manager address
    /// @param _riskManager risk manager address
    /// @param _referrals referrals address
    /// @param _stakingThales staking thales address
    /// @param _safeBox safeBox address
    function setAddresses(
        IERC20 _defaultCollateral,
        address _manager,
        address _riskManager,
        address _resultManager,
        address _referrals,
        address _stakingThales,
        address _safeBox
    ) external onlyOwner {
        defaultCollateral = _defaultCollateral;
        manager = ISportsAMMV2Manager(_manager);
        riskManager = ISportsAMMV2RiskManager(_riskManager);
        resultManager = ISportsAMMV2ResultManager(_resultManager);
        referrals = IReferrals(_referrals);
        stakingThales = IStakingThales(_stakingThales);
        safeBox = _safeBox;

        emit AddressesUpdated(
            _defaultCollateral,
            _manager,
            _riskManager,
            _resultManager,
            _referrals,
            _stakingThales,
            _safeBox
        );
    }

    function setLiveTradingProcessor(address _liveTradingProcessor) external onlyOwner {
        liveTradingProcessor = _liveTradingProcessor;
        emit SetLiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice sets different times/periods
    /// @param _minimalTimeLeftToMaturity  the period of time in seconds before a game is matured and begins to be restricted for AMM trading
    /// @param _expiryDuration the period of time in seconds after mauturity when ticket expires
    function setTimes(uint _minimalTimeLeftToMaturity, uint _expiryDuration) external onlyOwner {
        minimalTimeLeftToMaturity = _minimalTimeLeftToMaturity;
        expiryDuration = _expiryDuration;
        emit TimesUpdated(_minimalTimeLeftToMaturity, _expiryDuration);
    }

    /// @notice sets new Ticket Mastercopy address
    /// @param _ticketMastercopy new Ticket Mastercopy address
    function setTicketMastercopy(address _ticketMastercopy) external onlyOwner {
        ticketMastercopy = _ticketMastercopy;
        emit TicketMastercopyUpdated(_ticketMastercopy);
    }

    /// @notice sets new LP address
    /// @param _liquidityPool new LP address
    function setLiquidityPool(address _liquidityPool) external onlyOwner {
        if (address(liquidityPool) != address(0)) {
            defaultCollateral.approve(address(liquidityPool), 0);
        }
        liquidityPool = ISportsAMMV2LiquidityPool(_liquidityPool);
        defaultCollateral.approve(_liquidityPool, MAX_APPROVAL);
        emit SetLiquidityPool(_liquidityPool);
    }

    /// @notice sets new LP Pool with LP address and the supported collateral
    /// @param _collateralAddress collateral address that is supported by the pool
    /// @param _liquidityPool new LP address
    function setCollateralLiquidityPool(address _collateralAddress, address _liquidityPool) external onlyOwner {
        if (collateralPool[_collateralAddress] != address(0)) {
            IERC20(_collateralAddress).approve(_liquidityPool, 0);
        }
        collateralPool[_collateralAddress] = _liquidityPool;
        IERC20(_collateralAddress).approve(_liquidityPool, MAX_APPROVAL);
        emit SetLiquidityPoolForCollateral(_liquidityPool, _collateralAddress);
    }

    /// @notice sets multi-collateral on/off ramp contract and enable/disable
    /// @param _onOffRamper new multi-collateral on/off ramp address
    /// @param _enabled enable/disable multi-collateral on/off ramp
    function setMultiCollateralOnOffRamp(address _onOffRamper, bool _enabled) external onlyOwner {
        if (address(multiCollateralOnOffRamp) != address(0)) {
            defaultCollateral.approve(address(multiCollateralOnOffRamp), 0);
        }
        multiCollateralOnOffRamp = IMultiCollateralOnOffRamp(_onOffRamper);
        multicollateralEnabled = _enabled;
        if (_enabled) {
            defaultCollateral.approve(_onOffRamper, MAX_APPROVAL);
        }
        emit SetMultiCollateralOnOffRamp(_onOffRamper, _enabled);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        require(knownTickets.contains(_ticket), "Unknown ticket");
        _;
    }

    modifier onlyWhitelistedAddresses(address sender) {
        require(
            sender == owner || manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.ROOT_SETTING),
            "Invalid sender"
        );
        _;
    }

    /* ========== EVENTS ========== */

    event NewTicket(Ticket.MarketData[] markets, address ticket, uint buyInAmount, uint payout);
    event TicketCreated(
        address ticket,
        address differentRecipient,
        uint buyInAmount,
        uint fees,
        uint payout,
        uint totalQuote
    );

    event TicketResolved(address ticket, address ticketOwner, bool isUserTheWinner);
    event ReferrerPaid(address refferer, address trader, uint amount, uint volume);
    event SafeBoxFeePaid(uint safeBoxFee, uint safeBoxAmount);

    event GameRootUpdated(bytes32 game, bytes32 root);
    event AmountsUpdated(
        uint safeBoxFee,
        uint minBuyInAmount,
        uint maxTicketSize,
        uint maxSupportedAmount,
        uint maxSupportedOdds
    );
    event AddressesUpdated(
        IERC20 defaultCollateral,
        address manager,
        address riskManager,
        address resultManager,
        address referrals,
        address stakingThales,
        address safeBox
    );
    event TimesUpdated(uint minimalTimeLeftToMaturity, uint expiryDuration);
    event TicketMastercopyUpdated(address ticketMastercopy);
    event SetLiquidityPool(address liquidityPool);
    event SetLiquidityPoolForCollateral(address liquidityPool, address collateral);
    event SetMultiCollateralOnOffRamp(address onOffRamper, bool enabled);
    event SetLiveTradingProcessor(address liveTradingProcessor);
}
