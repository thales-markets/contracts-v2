// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/libraries/AddressSetLib.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ILiveTradingProcessor.sol";

import "./../AMM/Ticket.sol";

contract FreeBetsHolder is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

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

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner, address _sportsAMMV2, address _liveTradingProcessor) external initializer {
        setOwner(_owner);
        initNonReentrant();
        sportsAMM = ISportsAMMV2(_sportsAMMV2);
        liveTradingProcessor = ILiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice fund a batch of users with free bets in chosen collateral
    function fundBatch(address[] calldata _users, address _collateral, uint _amountPerUser) external notPaused {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _amountPerUser * _users.length);
        for (uint256 index = 0; index < _users.length; index++) {
            address _user = _users[index];
            balancePerUserAndCollateral[_user][_collateral] += _amountPerUser;
            emit UserFunded(_user, _collateral, _amountPerUser, msg.sender);
        }
    }

    /// @notice fund a single user with free bets in chosen collateral
    function fund(address _user, address _collateral, uint _amount) external notPaused {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _amount);
        balancePerUserAndCollateral[_user][_collateral] += _amount;
        emit UserFunded(_user, _collateral, _amount, msg.sender);
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
        balancePerUserAndCollateral[msg.sender][_collateral] -= _buyInAmount;
        address _createdTicket = sportsAMM.trade(
            _tradeData,
            _buyInAmount,
            _expectedQuote,
            _additionalSlippage,
            _referrer,
            _collateral,
            false
        );
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
        require(msg.sender == address(liveTradingProcessor), "Only callable from LiveTradingProcessor");

        address _user = liveRequestsPerUser[requestId];
        require(_user != address(0), "Unknown live ticket");

        if (_collateral == address(0)) {
            _collateral = address(sportsAMM.defaultCollateral());
        }

        require(supportedCollateral[_collateral], "Unsupported collateral");
        require(balancePerUserAndCollateral[_user][_collateral] >= _buyInAmount, "Insufficient balance");

        balancePerUserAndCollateral[_user][_collateral] -= _buyInAmount;
        ticketToUser[_createdTicket] = _user;

        activeTicketsPerUser[_user].add(_createdTicket);

        emit FreeBetTrade(_createdTicket, _buyInAmount, _user, true);
    }

    /// @notice callback from sportsAMM on ticket exercize if owner is this contract. The net winnings are sent to users while the freebet amount goes back to the freebet balance
    function confirmTicketResolved(address _resolvedTicket) external {
        require(msg.sender == address(sportsAMM), "Only allowed from SportsAMM");

        address _user = ticketToUser[_resolvedTicket];
        require(_user != address(0), "Unknown ticket");
        require(activeTicketsPerUser[_user].contains(_resolvedTicket), "Unknown active ticket");

        uint _exercized = Ticket(_resolvedTicket).finalPayout();
        uint _earned;
        if (_exercized > 0) {
            IERC20 _collateral = Ticket(_resolvedTicket).collateral();
            uint buyInAmount = Ticket(_resolvedTicket).buyInAmount();
            balancePerUserAndCollateral[_user][address(_collateral)] += buyInAmount;

            _earned = _exercized - buyInAmount;
            if (_earned > 0) {
                _collateral.safeTransfer(_user, _earned);
            }
        }
        emit FreeBetTicketResolved(_resolvedTicket, _user, _earned);

        activeTicketsPerUser[_user].remove(_resolvedTicket);
        resolvedTicketsPerUser[_user].add(_resolvedTicket);
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

    /* ========== MODIFIERS ========== */
    modifier canTrade(
        address _user,
        address _collateral,
        uint _amount
    ) {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        require(balancePerUserAndCollateral[_user][_collateral] >= _amount, "Insufficient balance");
        _;
    }

    /* ========== EVENTS ========== */

    event UserFunded(address user, address collateral, uint amount, address funder);
    event FreeBetTrade(address createdTicket, uint buyInAmount, address user, bool isLive);
    event CollateralSupportChanged(address collateral, bool supported);
    event FreeBetTicketResolved(address ticket, address user, uint earned);
    event FreeBetLiveTradeRequested(address user, uint buyInAmount, bytes32 requestId);
}
