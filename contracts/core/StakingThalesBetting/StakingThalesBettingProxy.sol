// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/libraries/AddressSetLib.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ILiveTradingProcessor.sol";

import "./../AMM/Ticket.sol";

contract StakingThalesBettingProxy is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

    uint private constant MAX_APPROVAL = type(uint256).max;

    ISportsAMMV2 public sportsAMM;

    ILiveTradingProcessor public liveTradingProcessor;

    IStakingThales public stakingThales;

    IERC20 public stakingCollateral;

    mapping(address => address) public ticketToUser;

    mapping(bytes32 => address) public liveRequestsPerUser;

    // stores active tickets per user
    mapping(address => AddressSetLib.AddressSet) internal activeTicketsPerUser;

    // stores resolved tickets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedTicketsPerUser;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        address _owner,
        address _sportsAMMV2,
        address _liveTradingProcessor,
        address _stakingThales,
        address _stakingToken
    ) external initializer {
        setOwner(_owner);
        initNonReentrant();
        sportsAMM = ISportsAMMV2(_sportsAMMV2);
        liveTradingProcessor = ILiveTradingProcessor(_liveTradingProcessor);
        stakingThales = IStakingThales(_stakingThales);
        stakingCollateral = IERC20(_stakingToken);
        stakingCollateral.approve(_stakingThales, MAX_APPROVAL);
        stakingCollateral.approve(_sportsAMMV2, MAX_APPROVAL);
        stakingCollateral.approve(_liveTradingProcessor, MAX_APPROVAL);
    }

    /// @notice buy a ticket for a user if he has enough free bet in given collateral
    function trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer
    ) external notPaused nonReentrant canTrade(msg.sender, _buyInAmount) {
        // signal decrease of stakingAmount
        stakingThales.decreaseStakingBalanceFor(msg.sender, _buyInAmount);
        address _createdTicket = sportsAMM.trade(
            _tradeData,
            _buyInAmount,
            _expectedQuote,
            _additionalSlippage,
            _referrer,
            address(stakingCollateral),
            false
        );
        ticketToUser[_createdTicket] = msg.sender;
        activeTicketsPerUser[msg.sender].add(_createdTicket);
        emit StakingTokensTrade(_createdTicket, _buyInAmount, msg.sender, false);
    }

    /// @notice request a live ticket for a user if he has enough free bet in given collateral
    function tradeLive(
        ILiveTradingProcessor.LiveTradeData calldata _liveTradeData
    ) external notPaused canTrade(msg.sender, _liveTradeData._buyInAmount) {
        bytes32 _requestId = liveTradingProcessor.requestLiveTrade(_liveTradeData);
        liveRequestsPerUser[_requestId] = msg.sender;
        emit FreeBetLiveTradeRequested(msg.sender, _liveTradeData._buyInAmount, _requestId);
    }

    function preConfirmLiveTrade(bytes32 requestId, uint _buyInAmount) external notPaused nonReentrant {
        require(msg.sender == address(liveTradingProcessor), "Only callable from LiveTradingProcessor");
        address _user = liveRequestsPerUser[requestId];
        require(_user != address(0), "Unknown live ticket");
        // signal decrease of stakingAmount
        stakingThales.decreaseStakingBalanceFor(_user, _buyInAmount);
    }

    /// @notice confirm a live ticket purchase. As live betting is a 2 step approach, the LiveTradingProcessor needs this method as callback so that the correct amount is deducted from the user's balance
    function confirmLiveTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount) external notPaused nonReentrant {
        require(msg.sender == address(liveTradingProcessor), "Only callable from LiveTradingProcessor");
        address _user = liveRequestsPerUser[requestId];
        require(_user != address(0), "Unknown live ticket");

        ticketToUser[_createdTicket] = _user;

        activeTicketsPerUser[_user].add(_createdTicket);

        emit StakingTokensTrade(_createdTicket, _buyInAmount, _user, true);
    }

    /// @notice callback from sportsAMM on ticket exercize if owner is this contract. The net winnings are sent to users while the freebet amount goes back to the freebet balance
    function confirmTicketResolved(address _resolvedTicket) external {
        require(msg.sender == address(sportsAMM), "Only allowed from SportsAMM");

        address _user = ticketToUser[_resolvedTicket];
        require(_user != address(0), "Unknown ticket");
        require(activeTicketsPerUser[_user].contains(_resolvedTicket), "Unknown active ticket");

        uint _exercized = Ticket(_resolvedTicket).finalPayout();
        if (_exercized > 0) {
            stakingThales.increaseStakingBalanceFor(_user, _exercized);
        }
        emit StakingTokensTicketResolved(_resolvedTicket, _user, _exercized);

        activeTicketsPerUser[_user].remove(_resolvedTicket);
        resolvedTicketsPerUser[_user].add(_resolvedTicket);
    }

    /// @notice admin method to retrieve stuck funds if needed
    function retrieveFunds(IERC20 _collateral, uint _amount) external onlyOwner {
        _collateral.safeTransfer(msg.sender, _amount);
    }

    /* ========== SETTERS ========== */

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
    modifier canTrade(address _user, uint _amount) {
        require(stakingThales.stakedBalanceOf(_user) >= _amount, "Insufficient staked balance");
        _;
    }

    /* ========== EVENTS ========== */

    event StakingAmountApprovedForTrading(address user, uint amount);
    event UserFunded(address user, address collateral, uint amount, address funder);
    event StakingTokensTrade(address createdTicket, uint buyInAmount, address user, bool isLive);
    event CollateralSupportChanged(address collateral, bool supported);
    event StakingTokensTicketResolved(address ticket, address user, uint earned);
    event FreeBetLiveTradeRequested(address user, uint buyInAmount, bytes32 requestId);
}
