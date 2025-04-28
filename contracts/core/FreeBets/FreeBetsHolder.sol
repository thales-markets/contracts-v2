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
import "../../interfaces/ISGPTradingProcessor.sol";

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

    ISGPTradingProcessor public sgpTradingProcessor;

    mapping(bytes32 => address) public sgpRequestsPerUser;

    mapping(address => mapping(address => uint)) public freeBetExpiration;

    uint public freeBetExpirationPeriod;

    uint public freeBetExpirationUpgrade;

    mapping(address => AddressSetLib.AddressSet) internal usersWithFreeBetPerCollateral;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner, address _sportsAMMV2, address _liveTradingProcessor) external initializer {
        setOwner(_owner);
        initNonReentrant();
        sportsAMM = ISportsAMMV2(_sportsAMMV2);
        liveTradingProcessor = ILiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice fund a batch of users with free bets in chosen collateral
    function fundBatch(address[] calldata _users, address _collateral, uint _amountPerUser) external notPaused nonReentrant {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _amountPerUser * _users.length);
        for (uint256 index = 0; index < _users.length; index++) {
            address _user = _users[index];
            usersWithFreeBetPerCollateral[_collateral].add(_user);
            _fundUser(_user, _collateral, _amountPerUser, msg.sender);
        }
    }

    /// @notice fund a single user with free bets in chosen collateral
    function fund(address _user, address _collateral, uint _amount) external notPaused nonReentrant {
        require(supportedCollateral[_collateral], "Unsupported collateral");
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
        for (uint256 index = 0; index < _users.length; index++) {
            address _user = _users[index];
            require(
                (freeBetExpiration[_user][_collateral] > 0 && freeBetExpiration[_user][_collateral] < block.timestamp) ||
                    (freeBetExpiration[_user][_collateral] == 0 &&
                        freeBetExpirationUpgrade + freeBetExpirationPeriod < block.timestamp),
                "Free bet not expired"
            );
            _removeUserFunding(_user, _collateral, owner);
        }
    }

    /// @notice admin method to unallocate free bets that aren't used in a while
    function removeUserFundingBatch(
        address[] calldata _users,
        address _collateral,
        address _receiver
    ) external notPaused nonReentrant onlyOwner {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        for (uint256 index = 0; index < _users.length; index++) {
            address _user = _users[index];
            _removeUserFunding(_user, _collateral, _receiver);
        }
    }

    function _removeUserFunding(address _user, address _collateral, address _receiver) internal {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        IERC20(_collateral).safeTransfer(_receiver, balancePerUserAndCollateral[_user][_collateral]);
        uint _amountRemoved = balancePerUserAndCollateral[_user][_collateral];
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
        require(msg.sender == address(sgpTradingProcessor), "Only callable from SGPTradingProcessor");

        address _user = sgpRequestsPerUser[requestId];
        require(_user != address(0), "Unknown SGP ticket");

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
            freeBetExpiration[_user][address(_collateral)] = block.timestamp + freeBetExpirationPeriod;
            if (_exercized >= buyInAmount) {
                balancePerUserAndCollateral[_user][address(_collateral)] += buyInAmount;
                _earned = _exercized - buyInAmount;
                if (_earned > 0) {
                    _collateral.safeTransfer(_user, _earned);
                }
            } else {
                balancePerUserAndCollateral[_user][address(_collateral)] += _exercized;
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

    /// @notice checks if a free bet is valid
    /// @param _user the address of the user
    /// @param _collateral the address of the collateral
    /// @return isValid true if the free bet is valid, false otherwise
    /// @return timeToExpiration the time to expiration of the free bet, 0 if the free bet is not valid
    function isFreeBetValid(address _user, address _collateral) external view returns (bool isValid, uint timeToExpiration) {
        (isValid, timeToExpiration) = _isFreeBetValid(_user, _collateral);
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

    /// @notice get users with valid free bet per collateral
    /// @param _collateral the address of the collateral
    /// @param _index the start index
    /// @param _pageSize the page size
    /// @return users
    function getUsersWithValidFreeBetPerCollateral(
        address _collateral,
        uint _index,
        uint _pageSize
    ) external view returns (address[] memory) {
        if (_pageSize > usersWithFreeBetPerCollateral[_collateral].elements.length) {
            _pageSize = usersWithFreeBetPerCollateral[_collateral].elements.length;
        }
        address[] memory allValidUsers = new address[](_pageSize);
        uint validUsersCount = 0;
        for (uint i = 0; i < _pageSize; i++) {
            address user = usersWithFreeBetPerCollateral[_collateral].elements[_index + i];
            (bool isValid, ) = _isFreeBetValid(user, _collateral);
            if (isValid) {
                allValidUsers[validUsersCount] = user;
                validUsersCount++;
            }
        }
        address[] memory validUsers = new address[](validUsersCount);
        for (uint i = 0; i < validUsersCount; i++) {
            validUsers[i] = allValidUsers[i];
        }
        return validUsers;
    }

    /// @notice get users with invalid free bet per collateral
    /// @param _collateral the address of the collateral
    /// @param _index the start index
    /// @param _pageSize the page size
    /// @return users
    function getUsersWithInvalidFreeBetPerCollateral(
        address _collateral,
        uint _index,
        uint _pageSize
    ) external view returns (address[] memory) {
        if (_pageSize > usersWithFreeBetPerCollateral[_collateral].elements.length) {
            _pageSize = usersWithFreeBetPerCollateral[_collateral].elements.length;
        }
        address[] memory allUsers = new address[](_pageSize);
        uint invalidUsersCount = 0;
        for (uint i = 0; i < _pageSize; i++) {
            address user = usersWithFreeBetPerCollateral[_collateral].elements[_index + i];
            (bool isValid, ) = _isFreeBetValid(user, _collateral);
            if (!isValid) {
                allUsers[invalidUsersCount] = user;
                invalidUsersCount++;
            }
        }
        address[] memory invalidUsers = new address[](invalidUsersCount);
        for (uint i = 0; i < invalidUsersCount; i++) {
            invalidUsers[i] = allUsers[i];
        }
        return invalidUsers;
    }

    /* ========== SETTERS ========== */
    /// @notice sets the LiveTradingProcessor contract address
    /// @param _liveTradingProcessor the address of Live Trading Processor contract
    function setLiveTradingProcessor(address _liveTradingProcessor) external onlyOwner {
        require(_liveTradingProcessor != address(0), "Invalid address");
        liveTradingProcessor = ILiveTradingProcessor(_liveTradingProcessor);
        emit SetLiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice sets the SGPTradingProcessor contract address
    /// @param _sgpTradingProcessor the address of SGP Trading Processor contract
    function setSGPTradingProcessor(address _sgpTradingProcessor) external onlyOwner {
        require(_sgpTradingProcessor != address(0), "Invalid address");
        sgpTradingProcessor = ISGPTradingProcessor(_sgpTradingProcessor);
        emit SetSGPTradingProcessor(_sgpTradingProcessor);
    }

    /// @notice sets the Sports AMM contract address
    /// @param _sportsAMM the address of Sports AMM contract
    function setSportsAMM(address _sportsAMM) external onlyOwner {
        require(_sportsAMM != address(0), "Invalid address");
        sportsAMM = ISportsAMMV2(_sportsAMM);
        emit SetSportsAMM(_sportsAMM);
    }

    /// @notice sets the free bet expiration period
    /// @param _freeBetExpirationPeriod the new free bet expiration period
    function setFreeBetExpirationPeriod(uint _freeBetExpirationPeriod, uint _freeBetExpirationUpgrade) external onlyOwner {
        freeBetExpirationPeriod = _freeBetExpirationPeriod;
        if (_freeBetExpirationUpgrade == 0) {
            freeBetExpirationUpgrade = block.timestamp;
        } else {
            freeBetExpirationUpgrade = _freeBetExpirationUpgrade;
        }
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
        for (uint i = 0; i < _users.length; i++) {
            usersWithFreeBetPerCollateral[_collateral].add(_users[i]);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _fundUser(address _user, address _collateral, uint _amount, address _sender) internal {
        usersWithFreeBetPerCollateral[_collateral].add(_user);
        balancePerUserAndCollateral[_user][_collateral] += _amount;
        freeBetExpiration[_user][_collateral] = freeBetExpirationPeriod > 0 ? block.timestamp + freeBetExpirationPeriod : 0;
        emit UserFunded(_user, _collateral, _amount, _sender);
    }

    function _isFreeBetValid(
        address _user,
        address _collateral
    ) internal view returns (bool isValid, uint timeToExpiration) {
        if (supportedCollateral[_collateral] && balancePerUserAndCollateral[_user][_collateral] > 0) {
            if (freeBetExpiration[_user][_collateral] == 0) {
                timeToExpiration = freeBetExpirationUpgrade + freeBetExpirationPeriod > block.timestamp
                    ? freeBetExpirationUpgrade + freeBetExpirationPeriod - block.timestamp
                    : 0;
            } else {
                timeToExpiration = freeBetExpiration[_user][_collateral] > block.timestamp
                    ? freeBetExpiration[_user][_collateral] - block.timestamp
                    : 0;
            }
            isValid = timeToExpiration > 0;
        }
    }

    /* ========== MODIFIERS ========== */
    modifier canTrade(
        address _user,
        address _collateral,
        uint _amount
    ) {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        require(balancePerUserAndCollateral[_user][_collateral] >= _amount, "Insufficient balance");
        require(
            freeBetExpiration[_user][_collateral] > block.timestamp ||
                (freeBetExpiration[_user][_collateral] == 0 &&
                    freeBetExpirationUpgrade + freeBetExpirationPeriod > block.timestamp),
            "Free bet expired"
        );
        _;
    }

    /* ========== EVENTS ========== */
    event SetSportsAMM(address sportsAMM);
    event SetLiveTradingProcessor(address liveTradingProcessor);
    event SetSGPTradingProcessor(address sgpTradingProcessor);
    event UserFunded(address user, address collateral, uint amount, address funder);
    event FreeBetTrade(address createdTicket, uint buyInAmount, address user, bool isLive);
    event CollateralSupportChanged(address collateral, bool supported);
    event FreeBetTicketResolved(address ticket, address user, uint earned);
    event FreeBetLiveTradeRequested(address user, uint buyInAmount, bytes32 requestId);
    event FreeBetSGPTradeRequested(address user, uint buyInAmount, bytes32 requestId);
    event UserFundingRemoved(address _user, address _collateral, address _receiver, uint _amount);
    event SetFreeBetExpirationPeriod(uint freeBetExpirationPeriod, uint freeBetExpirationUpgrade);
}
