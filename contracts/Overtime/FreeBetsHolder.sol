// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// internal
// TODO: why do we still use these synthetix contracts?
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../interfaces/ISportsAMMV2.sol";
import "../interfaces/ILiveTradingProcessor.sol";
import "./Ticket.sol";

contract FreeBetsHolder is Initializable, ProxyOwned, ProxyPausable {
    using SafeERC20 for IERC20;

    uint private constant MAX_APPROVAL = type(uint256).max;

    ISportsAMMV2 public sportsAMM;

    ILiveTradingProcessor public liveTradingProcessor;

    mapping(address => mapping(address => uint)) public balancePerUserAndCollateral;

    mapping(address => bool) public supportedCollateral;

    mapping(address => address) public ticketToUser;

    mapping(address => uint) public paidPerTicket;

    mapping(bytes32 => address) public liveRequestsPerUser;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner, address _sportsAMMV2, address _liveTradingProcessor) external initializer {
        setOwner(_owner);
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
        uint _expectedPayout,
        uint _additionalSlippage,
        address _referrer,
        address _collateral
    ) external notPaused canTrade(msg.sender, _collateral, _buyInAmount) {
        balancePerUserAndCollateral[msg.sender][_collateral] -= _buyInAmount;
        address _createdTicket = sportsAMM.trade(
            _tradeData,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            address(0),
            _referrer,
            _collateral == address(sportsAMM.defaultCollateral()) ? address(0) : _collateral,
            false
        );
        ticketToUser[_createdTicket] = msg.sender;
        emit FreeBetTrade(_createdTicket, _buyInAmount, msg.sender, false);
    }

    /// @notice request a live ticket for a user if he has enough free bet in given collateral
    function tradeLive(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _referrer,
        address _collateral
    ) external notPaused canTrade(msg.sender, _collateral, _buyInAmount) {
        bytes32 _requestId = liveTradingProcessor.requestLiveTrade(
            _gameId,
            _sportId,
            _typeId,
            _position,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            address(0),
            _referrer,
            _collateral
        );
        liveRequestsPerUser[_requestId] = msg.sender;
        emit FreeBetLiveTradeRequested(msg.sender, _buyInAmount, _requestId);
    }

    /// @notice confirm a live ticket purchase. As live betting is a 2 step approach, the LiveTradingProcessor needs this method as callback so that the correct amount is deducted from the user's balance
    function confirmLiveTrade(
        bytes32 requestId,
        address _createdTicket,
        uint _buyInAmount,
        address _collateral
    ) external notPaused {
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

        emit FreeBetTrade(_createdTicket, _buyInAmount, msg.sender, true);
    }

    /// @notice claim a known ticket purchased previously by FreeBetsHolder. The net winnings are sent to user, while the buyIn amount goes back to freeBet balance for further use
    function claimTicket(address _ticket) external notPaused {
        address _user = ticketToUser[_ticket];
        require(_user != address(0), "Unknown ticket");
        IERC20 _collateral = Ticket(_ticket).collateral();
        uint balanceBefore = _collateral.balanceOf(address(this));
        sportsAMM.exerciseTicket(_ticket);
        uint balanceAfter = _collateral.balanceOf(address(this));
        uint exercized = balanceAfter - balanceBefore;
        if (exercized > 0) {
            //TODO: can it happen that user claims less than what he paid?
            uint earned = exercized - Ticket(_ticket).buyInAmount();
            IERC20(_collateral).safeTransfer(_user, earned);
            balancePerUserAndCollateral[_user][address(_collateral)] += Ticket(_ticket).buyInAmount();
            emit FreeBetTicketClaimed(_ticket, earned);
        }
    }

    /// @notice admin method to retrieve stuck funds should it happen to should this contract be deprecated
    function retrieveFunds(IERC20 collateral, uint amount) external onlyOwner {
        collateral.safeTransfer(msg.sender, amount);
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
        emit AddSupportedCollateral(_collateral, _supported);
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
    event AddSupportedCollateral(address collateral, bool supported);
    event FreeBetTicketClaimed(address ticket, uint earned);
    event FreeBetLiveTradeRequested(address user, uint buyInAmount, bytes32 requestId);
}
