// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@thales-dao/contracts/contracts/interfaces/IAddressManager.sol";

import "../../interfaces/ISpeedMarketsAMMCreator.sol";
import "../../interfaces/ISpeedMarketsAMM.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/libraries/AddressSetLib.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/ISGPTradingProcessor.sol";

import "./../AMM/Ticket.sol";

contract FreeBetsHolder is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

    // Custom errors
    error UnsupportedCollateral();
    error OnlyCallableFromLiveTradingProcessor();
    error UnknownLiveTicket();
    error InsufficientBalance();
    error OnlyCallableFromSGPTradingProcessor();
    error UnknownSGPTicket();
    error SpeedMarketsAMMCreatorNotSet();
    error DirectionsCannotBeEmpty();
    error CallerNotAllowed();
    error UnknownTicket();
    error UnknownActiveTicket();
    error InvalidAddress();
    error FreeBetExpired();
    error FreeBetNotExpired();
    error UnknownSpeedMarketTicketOwner();
    error OnlyCallableFromSpeedMarketsAMMCreator();

    uint private constant MAX_APPROVAL = type(uint256).max;

    ISportsAMMV2 public sportsAMM;

    ILiveTradingProcessor public liveTradingProcessor;

    mapping(address => mapping(address => uint)) public balancePerUserAndCollateral;

    mapping(address => bool) public supportedCollateral;

    mapping(address => address) public ticketToUser;

    mapping(address => uint) public paidPerTicket;

    mapping(bytes32 => address) public liveRequestsPerUser;

    // stores active tickets per user
    mapping(address => AddressSetLib.AddressSet) internal activeTicketsPerUser;

    // stores resolved tickets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedTicketsPerUser;

    ISGPTradingProcessor public sgpTradingProcessor;

    mapping(bytes32 => address) public sgpRequestsPerUser;

    mapping(address => mapping(address => uint)) public freeBetExpiration;

    uint public freeBetExpirationPeriod;

    uint public freeBetExpirationUpgrade;

    mapping(address => AddressSetLib.AddressSet) internal usersWithFreeBetPerCollateral;

    IAddressManager public addressManager;

    mapping(bytes32 => address) public speedMarketRequestToUser;

    // stores active speed markets per user
    mapping(address => AddressSetLib.AddressSet) internal activeSpeedMarketsPerUser;

    // stores resolved speed markets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedSpeedMarketsPerUser;

    // stores active chained speed markets per user
    mapping(address => AddressSetLib.AddressSet) internal activeChainedSpeedMarketsPerUser;

    // stores resolved chained speed markets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedChainedSpeedMarketsPerUser;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner, address _sportsAMMV2, address _liveTradingProcessor) external initializer {
        setOwner(_owner);
        initNonReentrant();
        sportsAMM = ISportsAMMV2(_sportsAMMV2);
        liveTradingProcessor = ILiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice fund a batch of users with free bets in chosen collateral
    function fundBatch(address[] calldata _users, address _collateral, uint _amountPerUser) external notPaused nonReentrant {
        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _amountPerUser * _users.length);
        for (uint256 index; index < _users.length; ++index) {
            address _user = _users[index];
            _fundUser(_user, _collateral, _amountPerUser, msg.sender);
        }
    }

    /// @notice fund a single user with free bets in chosen collateral
    function fund(address _user, address _collateral, uint _amount) external notPaused nonReentrant {
        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _amount);
        _fundUser(_user, _collateral, _amount, msg.sender);
    }

    /// @notice admin method to unallocate free bet that hasn't been used in a while
    function removeUserFunding(
        address _user,
        address _collateral,
        address _receiver
    ) external notPaused nonReentrant onlyOwner {
        _removeUserFunding(_user, _collateral, _receiver);
    }

    /// @notice Removes expired free bet funds from multiple users and transfers them to the owner
    /// @dev This function can be called by anyone, but only works for funds that have passed their expiration time
    /// @param _users Array of user addresses whose expired funds will be removed
    /// @param _collateral The token address of the collateral to be removed
    function removeExpiredUserFunding(address[] calldata _users, address _collateral) external notPaused nonReentrant {
        for (uint256 index; index < _users.length; ++index) {
            address _user = _users[index];
            if (balancePerUserAndCollateral[_user][_collateral] > 0) {
                if (
                    !((freeBetExpiration[_user][_collateral] > 0 &&
                        freeBetExpiration[_user][_collateral] < block.timestamp) ||
                        (freeBetExpiration[_user][_collateral] == 0 &&
                            freeBetExpirationUpgrade + freeBetExpirationPeriod < block.timestamp))
                ) {
                    revert FreeBetNotExpired();
                }
                _removeUserFunding(_user, _collateral, owner);
            }
        }
    }

    /// @notice admin method to unallocate free bets that aren't used in a while
    function removeUserFundingBatch(
        address[] calldata _users,
        address _collateral,
        address _receiver
    ) external notPaused nonReentrant onlyOwner {
        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        for (uint256 index; index < _users.length; ++index) {
            address _user = _users[index];
            _removeUserFunding(_user, _collateral, _receiver);
        }
    }

    function _removeUserFunding(address _user, address _collateral, address _receiver) internal {
        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        uint _amountRemoved = balancePerUserAndCollateral[_user][_collateral];
        uint currentBalance = IERC20(_collateral).balanceOf(address(this));
        if (_amountRemoved > 0 && currentBalance >= _amountRemoved) {
            IERC20(_collateral).safeTransfer(_receiver, _amountRemoved);
        }
        balancePerUserAndCollateral[_user][_collateral] = 0;
        if (usersWithFreeBetPerCollateral[_collateral].contains(_user)) {
            usersWithFreeBetPerCollateral[_collateral].remove(_user);
        }
        emit UserFundingRemoved(_user, _collateral, _receiver, _amountRemoved);
    }

    /// @notice buy a system bet ticket for a user if he has enough free bet in given collateral
    function tradeSystemBet(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        uint8 _systemBetDenominator
    ) external notPaused nonReentrant canTrade(msg.sender, _collateral, _buyInAmount) {
        _trade(_tradeData, _buyInAmount, _expectedQuote, _additionalSlippage, _referrer, _collateral, _systemBetDenominator);
    }

    /// @notice buy a ticket for a user if he has enough free bet in given collateral
    function trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral
    ) external notPaused nonReentrant canTrade(msg.sender, _collateral, _buyInAmount) {
        _trade(_tradeData, _buyInAmount, _expectedQuote, _additionalSlippage, _referrer, _collateral, 0);
    }

    function _trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        uint8 _systemBetDenominator
    ) internal {
        balancePerUserAndCollateral[msg.sender][_collateral] -= _buyInAmount;
        address _createdTicket;
        if (_systemBetDenominator > 0) {
            _createdTicket = sportsAMM.tradeSystemBet(
                _tradeData,
                _buyInAmount,
                _expectedQuote,
                _additionalSlippage,
                _referrer,
                _collateral,
                false,
                _systemBetDenominator
            );
        } else {
            _createdTicket = sportsAMM.trade(
                _tradeData,
                _buyInAmount,
                _expectedQuote,
                _additionalSlippage,
                _referrer,
                _collateral,
                false
            );
        }
        ticketToUser[_createdTicket] = msg.sender;
        activeTicketsPerUser[msg.sender].add(_createdTicket);
        emit FreeBetTrade(_createdTicket, _buyInAmount, msg.sender, false);
    }

    /// @notice request a live ticket for a user if he has enough free bet in given collateral
    function tradeLive(
        ILiveTradingProcessor.LiveTradeData calldata _liveTradeData
    ) external notPaused canTrade(msg.sender, _liveTradeData._collateral, _liveTradeData._buyInAmount) {
        bytes32 _requestId = liveTradingProcessor.requestLiveTrade(_liveTradeData);
        liveRequestsPerUser[_requestId] = msg.sender;
        emit FreeBetLiveTradeRequested(msg.sender, _liveTradeData._buyInAmount, _requestId);
    }

    /// @notice confirm a live ticket purchase. As live betting is a 2 step approach, the LiveTradingProcessor needs this method as callback so that the correct amount is deducted from the user's balance
    function confirmLiveTrade(
        bytes32 requestId,
        address _createdTicket,
        uint _buyInAmount,
        address _collateral
    ) external notPaused nonReentrant {
        if (msg.sender != address(liveTradingProcessor)) revert OnlyCallableFromLiveTradingProcessor();

        address _user = liveRequestsPerUser[requestId];
        if (_user == address(0)) revert UnknownLiveTicket();

        if (_collateral == address(0)) {
            _collateral = address(sportsAMM.defaultCollateral());
        }

        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        if (balancePerUserAndCollateral[_user][_collateral] < _buyInAmount) revert InsufficientBalance();

        balancePerUserAndCollateral[_user][_collateral] -= _buyInAmount;
        ticketToUser[_createdTicket] = _user;

        activeTicketsPerUser[_user].add(_createdTicket);

        emit FreeBetTrade(_createdTicket, _buyInAmount, _user, true);
    }

    /// @notice request a sgp ticket for a user if he has enough free bet in given collateral
    function tradeSGP(
        ISGPTradingProcessor.SGPTradeData calldata _sgpTradeData
    ) external notPaused canTrade(msg.sender, _sgpTradeData._collateral, _sgpTradeData._buyInAmount) {
        bytes32 _requestId = sgpTradingProcessor.requestSGPTrade(_sgpTradeData);
        sgpRequestsPerUser[_requestId] = msg.sender;
        emit FreeBetSGPTradeRequested(msg.sender, _sgpTradeData._buyInAmount, _requestId);
    }

    /// @notice confirm a SGP ticket purchase. As SGP betting is a 2 step approach, the SGPradingProcessor needs this method as callback so that the correct amount is deducted from the user's balance
    function confirmSGPTrade(
        bytes32 requestId,
        address _createdTicket,
        uint _buyInAmount,
        address _collateral
    ) external notPaused nonReentrant {
        if (msg.sender != address(sgpTradingProcessor)) revert OnlyCallableFromSGPTradingProcessor();

        address _user = sgpRequestsPerUser[requestId];
        if (_user == address(0)) revert UnknownSGPTicket();

        if (_collateral == address(0)) {
            _collateral = address(sportsAMM.defaultCollateral());
        }

        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        if (balancePerUserAndCollateral[_user][_collateral] < _buyInAmount) revert InsufficientBalance();

        balancePerUserAndCollateral[_user][_collateral] -= _buyInAmount;
        ticketToUser[_createdTicket] = _user;

        activeTicketsPerUser[_user].add(_createdTicket);

        emit FreeBetTrade(_createdTicket, _buyInAmount, _user, true);
    }

    /// @notice create a pending speed market for a user if he has enough free bet in given collateral
    function tradeSpeedMarket(
        ISpeedMarketsAMMCreator.SpeedMarketParams calldata _params
    ) external notPaused nonReentrant canTrade(msg.sender, _params.collateral, _params.buyinAmount) {
        address speedMarketsAMMCreator = addressManager.getAddress("SpeedMarketsAMMCreator");
        if (speedMarketsAMMCreator == address(0)) revert SpeedMarketsAMMCreatorNotSet();

        bytes32 _requestId = ISpeedMarketsAMMCreator(speedMarketsAMMCreator).addPendingSpeedMarket(_params);
        speedMarketRequestToUser[_requestId] = msg.sender;
        emit FreeBetSpeedMarketTradeRequested(
            msg.sender,
            _requestId,
            _params.buyinAmount,
            _params.asset,
            _params.strikeTime,
            _params.direction
        );
    }

    /// @notice create a pending chained speed market for a user if he has enough free bet in given collateral
    function tradeChainedSpeedMarket(
        ISpeedMarketsAMMCreator.ChainedSpeedMarketParams calldata _params
    ) external notPaused nonReentrant canTrade(msg.sender, _params.collateral, _params.buyinAmount) {
        address speedMarketsAMMCreator = addressManager.getAddress("SpeedMarketsAMMCreator");
        if (speedMarketsAMMCreator == address(0)) revert SpeedMarketsAMMCreatorNotSet();
        if (_params.directions.length == 0) revert DirectionsCannotBeEmpty();

        bytes32 _requestId = ISpeedMarketsAMMCreator(speedMarketsAMMCreator).addPendingChainedSpeedMarket(_params);
        speedMarketRequestToUser[_requestId] = msg.sender;
        emit FreeBetChainedSpeedMarketTradeRequested(
            msg.sender,
            _requestId,
            _params.buyinAmount,
            _params.asset,
            _params.timeFrame,
            _params.directions.length
        );
    }

    function confirmSpeedOrChainedSpeedMarketTrade(
        bytes32 requestId,
        address _createdTicket,
        address _collateral,
        uint _buyInAmount,
        bool _isChainedSpeedMarket
    ) external notPaused nonReentrant {
        address speedMarketsAMMCreator = addressManager.getAddress("SpeedMarketsAMMCreator");
        if (msg.sender != speedMarketsAMMCreator) revert OnlyCallableFromSpeedMarketsAMMCreator();
        if (_collateral == address(0)) {
            ISpeedMarketsAMM speedMarketsAMM = ISpeedMarketsAMM(addressManager.getAddress("SpeedMarketsAMM"));
            _collateral = speedMarketsAMM.sUSD();
        }
        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();

        address _user = speedMarketRequestToUser[requestId];
        if (_user == address(0)) revert UnknownSpeedMarketTicketOwner();

        if (balancePerUserAndCollateral[_user][_collateral] < _buyInAmount) revert InsufficientBalance();

        balancePerUserAndCollateral[_user][_collateral] -= _buyInAmount;
        ticketToUser[_createdTicket] = _user;
        if (_isChainedSpeedMarket) {
            activeChainedSpeedMarketsPerUser[_user].add(_createdTicket);
        } else {
            activeSpeedMarketsPerUser[_user].add(_createdTicket);
        }
        delete speedMarketRequestToUser[requestId];

        emit FreeBetSpeedTrade(_createdTicket, _buyInAmount, _user);
    }

    /// @notice callback from sportsAMM on ticket exercize if owner is this contract. The net winnings are sent to users while the freebet amount goes to the contract owner
    /// @param _resolvedTicket the address of the resolved ticket
    function confirmTicketResolved(address _resolvedTicket) external {
        if (msg.sender != address(sportsAMM)) revert CallerNotAllowed();
        address _user = ticketToUser[_resolvedTicket];
        if (_user == address(0)) revert UnknownTicket();
        if (!activeTicketsPerUser[_user].contains(_resolvedTicket)) revert UnknownActiveTicket();

        uint _earned;
        uint _exercized = Ticket(_resolvedTicket).finalPayout();
        IERC20 _collateral = Ticket(_resolvedTicket).collateral();
        uint buyInAmount = Ticket(_resolvedTicket).buyInAmount();
        _earned = _resolveMarket(_user, _collateral, _exercized, buyInAmount);

        activeTicketsPerUser[_user].remove(_resolvedTicket);
        resolvedTicketsPerUser[_user].add(_resolvedTicket);

        emit FreeBetTicketResolved(_resolvedTicket, _user, _earned);
    }

    function confirmSpeedMarketResolved(
        address _resolvedSpeedMarket,
        uint _exercized,
        uint _buyInAmount,
        address _collateral,
        bool isChained
    ) external {
        address speedMarketsAMMResolver = addressManager.getAddress("SpeedMarketsAMMResolver");
        if (msg.sender != speedMarketsAMMResolver) revert CallerNotAllowed();
        address _user = ticketToUser[_resolvedSpeedMarket];
        if (_user == address(0)) revert UnknownTicket();
        uint earned = _resolveMarket(_user, IERC20(_collateral), _exercized, _buyInAmount);

        if (isChained) {
            if (!activeChainedSpeedMarketsPerUser[_user].contains(_resolvedSpeedMarket)) revert UnknownActiveTicket();

            activeChainedSpeedMarketsPerUser[_user].remove(_resolvedSpeedMarket);
            resolvedChainedSpeedMarketsPerUser[_user].add(_resolvedSpeedMarket);
        } else {
            if (!activeSpeedMarketsPerUser[_user].contains(_resolvedSpeedMarket)) revert UnknownActiveTicket();

            activeSpeedMarketsPerUser[_user].remove(_resolvedSpeedMarket);
            resolvedSpeedMarketsPerUser[_user].add(_resolvedSpeedMarket);
        }

        emit FreeBetSpeedMarketResolved(_resolvedSpeedMarket, _user, earned);
    }

    /// @notice admin method to retrieve stuck funds if needed
    function retrieveFunds(IERC20 _collateral, uint _amount) external onlyOwner {
        _collateral.safeTransfer(msg.sender, _amount);
    }

    /* ========== SETTERS ========== */
    /// @notice add or remove a supported collateral
    function addSupportedCollateral(address _collateral, bool _supported) external onlyOwner {
        supportedCollateral[_collateral] = _supported;
        if (_supported) {
            IERC20(_collateral).approve(address(sportsAMM), MAX_APPROVAL);
        } else {
            IERC20(_collateral).approve(address(sportsAMM), 0);
        }
        emit CollateralSupportChanged(_collateral, _supported);
    }

    /* ========== GETTERS ========== */
    /// @notice gets batch of active tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active tickets for
    /// @return activeTickets
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return activeTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets batch of active speed markets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active speed markets for
    /// @return activeSpeedMarkets
    function getActiveSpeedMarketsPerUser(
        uint _index,
        uint _pageSize,
        address _user
    ) external view returns (address[] memory) {
        return activeSpeedMarketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets batch of active chained speed markets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active chained speed markets for
    /// @return activeChainedSpeedMarkets
    function getActiveChainedSpeedMarketsPerUser(
        uint _index,
        uint _pageSize,
        address _user
    ) external view returns (address[] memory) {
        return activeChainedSpeedMarketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets per user
    /// @param _user to get number of active tickets for
    /// @return numOfActiveTickets
    function numOfActiveTicketsPerUser(address _user) external view returns (uint) {
        return activeTicketsPerUser[_user].elements.length;
    }

    /// @notice gets number of active speed markets per user
    /// @param _user to get number of active speed markets for
    /// @return numOfActiveSpeedMarkets
    function numOfActiveSpeedMarketsPerUser(address _user) external view returns (uint) {
        return activeSpeedMarketsPerUser[_user].elements.length;
    }

    /// @notice gets number of active chained speed markets per user
    /// @param _user to get number of active speed markets for
    /// @return numOfActiveChainedSpeedMarkets
    function numOfActiveChainedSpeedMarketsPerUser(address _user) external view returns (uint) {
        return activeChainedSpeedMarketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of resolved tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved tickets for
    /// @return resolvedTickets
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return resolvedTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets batch of resolved speed markets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved speed markets for
    /// @return resolvedSpeedMarkets
    function getResolvedSpeedMarketsPerUser(
        uint _index,
        uint _pageSize,
        address _user
    ) external view returns (address[] memory) {
        return resolvedSpeedMarketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets batch of resolved speed markets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved speed markets for
    /// @return resolvedSpeedMarkets
    function getResolvedChainedSpeedMarketsPerUser(
        uint _index,
        uint _pageSize,
        address _user
    ) external view returns (address[] memory) {
        return resolvedChainedSpeedMarketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of resolved tickets per user
    /// @param _user to get number of resolved tickets for
    /// @return numOfResolvedTickets
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint) {
        return resolvedTicketsPerUser[_user].elements.length;
    }

    /// @notice gets number of resolved speed markets per user
    /// @param _user to get number of resolved speed markets for
    /// @return numOfResolvedSpeedMarkets
    function numOfResolvedSpeedMarketsPerUser(address _user) external view returns (uint) {
        return resolvedSpeedMarketsPerUser[_user].elements.length;
    }

    /// @notice gets number of resolved speed markets per user
    /// @param _user to get number of resolved speed markets for
    /// @return numOfResolvedSpeedMarkets
    function numOfResolvedChainedSpeedMarketsPerUser(address _user) external view returns (uint) {
        return resolvedChainedSpeedMarketsPerUser[_user].elements.length;
    }

    /// @notice checks if a free bet is valid
    /// @param _user the address of the user
    /// @param _collateral the address of the collateral
    /// @return isValid true if the free bet is valid, false otherwise
    /// @return timeToExpiration the time to expiration of the free bet, 0 if the free bet is not valid
    function isFreeBetValid(address _user, address _collateral) external view returns (bool isValid, uint timeToExpiration) {
        (isValid, timeToExpiration) = _isFreeBetValidAndTimeToExpiration(_user, _collateral);
    }

    /// @notice get users with free bet per collateral
    /// @param _collateral the address of the collateral
    /// @param _index the start index
    /// @param _pageSize the page size
    /// @return users
    function getUsersWithFreeBetPerCollateral(
        address _collateral,
        uint _index,
        uint _pageSize
    ) external view returns (address[] memory) {
        return usersWithFreeBetPerCollateral[_collateral].getPage(_index, _pageSize);
    }

    /// @notice get number of users with free bet per collateral
    /// @param _collateral the address of the collateral
    /// @return number of users
    function numOfUsersWithFreeBetPerCollateral(address _collateral) external view returns (uint) {
        return usersWithFreeBetPerCollateral[_collateral].elements.length;
    }

    /// @notice Get users with free bet per collateral, the free bet amount, if it's valid and the time to expiration
    /// @param _collateral the address of the collateral
    /// @param _index the start index
    /// @param _pageSize the page size
    /// @return allUsers
    /// @return freeBetAmounts
    /// @return isValid
    /// @return timeToExpiration
    function getUsersFreeBetDataPerCollateral(
        address _collateral,
        uint _index,
        uint _pageSize
    )
        external
        view
        returns (
            address[] memory allUsers,
            uint[] memory freeBetAmounts,
            bool[] memory isValid,
            uint[] memory timeToExpiration
        )
    {
        if (_pageSize > usersWithFreeBetPerCollateral[_collateral].elements.length) {
            _pageSize = usersWithFreeBetPerCollateral[_collateral].elements.length;
        }
        allUsers = new address[](_pageSize);
        isValid = new bool[](_pageSize);
        freeBetAmounts = new uint[](_pageSize);
        timeToExpiration = new uint[](_pageSize);
        for (uint i; i < _pageSize; ++i) {
            address user = usersWithFreeBetPerCollateral[_collateral].elements[_index + i];
            (isValid[i], timeToExpiration[i]) = _isFreeBetValidAndTimeToExpiration(user, _collateral);
            allUsers[i] = user;
            freeBetAmounts[i] = balancePerUserAndCollateral[user][_collateral];
        }
    }

    /* ========== SETTERS ========== */
    /// @notice sets the LiveTradingProcessor contract address
    /// @param _liveTradingProcessor the address of Live Trading Processor contract
    function setLiveTradingProcessor(address _liveTradingProcessor) external onlyOwner {
        if (_liveTradingProcessor == address(0)) revert InvalidAddress();
        liveTradingProcessor = ILiveTradingProcessor(_liveTradingProcessor);
        emit SetLiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice sets the SGPTradingProcessor contract address
    /// @param _sgpTradingProcessor the address of SGP Trading Processor contract
    function setSGPTradingProcessor(address _sgpTradingProcessor) external onlyOwner {
        if (_sgpTradingProcessor == address(0)) revert InvalidAddress();
        sgpTradingProcessor = ISGPTradingProcessor(_sgpTradingProcessor);
        emit SetSGPTradingProcessor(_sgpTradingProcessor);
    }

    /// @notice sets the Sports AMM contract address
    /// @param _sportsAMM the address of Sports AMM contract
    function setSportsAMM(address _sportsAMM) external onlyOwner {
        if (_sportsAMM == address(0)) revert InvalidAddress();
        sportsAMM = ISportsAMMV2(_sportsAMM);
        emit SetSportsAMM(_sportsAMM);
    }

    /// @notice sets the free bet expiration period
    /// @param _freeBetExpirationPeriod the new free bet expiration period
    function setFreeBetExpirationPeriod(uint _freeBetExpirationPeriod, uint _freeBetExpirationUpgrade) external onlyOwner {
        freeBetExpirationPeriod = _freeBetExpirationPeriod;
        freeBetExpirationUpgrade = _freeBetExpirationUpgrade == 0 ? block.timestamp : _freeBetExpirationUpgrade;
        emit SetFreeBetExpirationPeriod(_freeBetExpirationPeriod, _freeBetExpirationUpgrade);
    }

    /// @notice sets the free bet expiration for a user
    /// @param _user the address of the user
    /// @param _collateral the address of the collateral
    /// @param _freeBetExpiration the new free bet expiration
    function setUserFreeBetExpiration(address _user, address _collateral, uint _freeBetExpiration) external onlyOwner {
        freeBetExpiration[_user][_collateral] = _freeBetExpiration;
    }

    /// @notice sets the users with free bet per collateral
    /// @param _users the addresses of the users
    /// @param _collateral the address of the collateral
    function setUsersWithAlreadyFundedFreeBetPerCollateral(
        address[] calldata _users,
        address _collateral
    ) external onlyOwner {
        for (uint i; i < _users.length; ++i) {
            usersWithFreeBetPerCollateral[_collateral].add(_users[i]);
        }
    }

    /// @notice sets the Address Manager contract address
    /// @param _addressManager the address of Address Manager contract
    function setAddressManager(address _addressManager) external onlyOwner {
        if (_addressManager == address(0)) revert InvalidAddress();
        addressManager = IAddressManager(_addressManager);
        emit SetAddressManager(_addressManager);
    }

    function updateApprovalForSpeedMarketsAMM(address _collateral) external onlyOwner {
        address speedMarketsAMM = addressManager.getAddress("SpeedMarketsAMM");
        address chainSpeedMarketsAMM = addressManager.getAddress("ChainedSpeedMarketsAMM");
        if (speedMarketsAMM != address(0)) {
            IERC20(_collateral).approve(speedMarketsAMM, MAX_APPROVAL);
        }
        if (chainSpeedMarketsAMM != address(0)) {
            IERC20(_collateral).approve(chainSpeedMarketsAMM, MAX_APPROVAL);
        }
        emit UpdateMaxApprovalSpeedMarketsAMM(_collateral);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _resolveMarket(
        address _user,
        IERC20 _collateral,
        uint _exercized,
        uint _buyInAmount
    ) internal returns (uint earned) {
        if (_exercized > 0) {
            if (_exercized > _buyInAmount) {
                _collateral.safeTransfer(owner, _buyInAmount);
                earned = _exercized - _buyInAmount;
                if (earned > 0) {
                    _collateral.safeTransfer(_user, earned);
                }
            } else {
                balancePerUserAndCollateral[_user][address(_collateral)] += _exercized;
            }
        }
    }

    function _fundUser(address _user, address _collateral, uint _amount, address _sender) internal {
        usersWithFreeBetPerCollateral[_collateral].add(_user);
        balancePerUserAndCollateral[_user][_collateral] += _amount;
        freeBetExpiration[_user][_collateral] = block.timestamp + freeBetExpirationPeriod;
        emit UserFunded(_user, _collateral, _amount, _sender);
    }

    function _isFreeBetValidAndTimeToExpiration(
        address _user,
        address _collateral
    ) internal view returns (bool isValid, uint timeToExpiration) {
        if (supportedCollateral[_collateral] && balancePerUserAndCollateral[_user][_collateral] > 0) {
            uint expirationDate = freeBetExpiration[_user][_collateral] > 0
                ? freeBetExpiration[_user][_collateral]
                : freeBetExpirationUpgrade + freeBetExpirationPeriod;
            isValid = expirationDate > block.timestamp;
            timeToExpiration = isValid ? expirationDate - block.timestamp : 0;
        }
    }

    function _isFreeBetValid(address _user, address _collateral) internal view returns (bool) {
        return
            freeBetExpiration[_user][_collateral] > block.timestamp ||
            (freeBetExpiration[_user][_collateral] == 0 &&
                freeBetExpirationUpgrade + freeBetExpirationPeriod > block.timestamp);
    }

    /* ========== MODIFIERS ========== */
    modifier canTrade(
        address _user,
        address _collateral,
        uint _amount
    ) {
        if (!supportedCollateral[_collateral]) revert UnsupportedCollateral();
        if (balancePerUserAndCollateral[_user][_collateral] < _amount) revert InsufficientBalance();
        if (!_isFreeBetValid(_user, _collateral)) revert FreeBetExpired();
        _;
    }

    /* ========== EVENTS ========== */
    event SetSportsAMM(address sportsAMM);
    event SetLiveTradingProcessor(address liveTradingProcessor);
    event SetSGPTradingProcessor(address sgpTradingProcessor);
    event SetAddressManager(address addressManager);
    event UserFunded(address user, address collateral, uint amount, address funder);
    event FreeBetTrade(address createdTicket, uint buyInAmount, address user, bool isLive);
    event FreeBetSpeedTrade(address createdSpeedMarket, uint buyInAmount, address user);
    event CollateralSupportChanged(address collateral, bool supported);
    event FreeBetTicketResolved(address ticket, address user, uint earned);
    event FreeBetSpeedMarketResolved(address speedMarket, address user, uint earned);
    event FreeBetLiveTradeRequested(address user, uint buyInAmount, bytes32 requestId);
    event FreeBetSGPTradeRequested(address user, uint buyInAmount, bytes32 requestId);
    event FreeBetSpeedMarketTradeRequested(
        address user,
        bytes32 requestId,
        uint buyInAmount,
        bytes32 asset,
        uint64 strikeTime,
        ISpeedMarketsAMMCreator.Direction direction
    );
    event FreeBetChainedSpeedMarketTradeRequested(
        address user,
        bytes32 requestId,
        uint buyInAmount,
        bytes32 asset,
        uint64 timeFrame,
        uint directionsCount
    );
    event UserFundingRemoved(address _user, address _collateral, address _receiver, uint _amount);
    event SetFreeBetExpirationPeriod(uint freeBetExpirationPeriod, uint freeBetExpirationUpgrade);
    event UpdateMaxApprovalSpeedMarketsAMM(address collateral);
}
