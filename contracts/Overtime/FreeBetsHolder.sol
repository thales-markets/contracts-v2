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

    function fund(address _user, address _collateral, uint _amount) external notPaused {
        require(supportedCollateral[_collateral], "Unsupported collateral");
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _amount);
        balancePerUserAndCollateral[_user][_collateral] += _amount;
        emit UserFunded(_user, _collateral, _amount, msg.sender);
    }

    function trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _referrer,
        address _collateral
    ) external notPaused canTrade(msg.sender, _collateral, _buyInAmount) {
        balancePerUserAndCollateral[msg.sender][_collateral] -= _buyInAmount;
        address createdTicket = sportsAMM.trade(
            _tradeData,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            address(0),
            _referrer,
            _collateral == address(sportsAMM.defaultCollateral()) ? address(0) : _collateral,
            false
        );
        ticketToUser[createdTicket] = msg.sender;
    }

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
    }

    function confirmLiveTrade(
        bytes32 requestId,
        address _createdTicket,
        uint _buyInAmount,
        address _collateral
    ) external notPaused {
        address _user = liveRequestsPerUser[requestId];
        require(_user != address(0), "Unknown live ticket");

        require(supportedCollateral[_collateral], "Unsupported collateral");
        require(balancePerUserAndCollateral[_user][_collateral] >= _buyInAmount, "Insufficient balance");

        balancePerUserAndCollateral[_user][_collateral] -= _buyInAmount;
        ticketToUser[_createdTicket] = _user;
    }

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
        }
    }

    function addSupportedCollateral(address _collateral, bool _supported) external onlyOwner {
        supportedCollateral[_collateral] = _supported;
        if (_supported) {
            IERC20(_collateral).approve(address(sportsAMM), MAX_APPROVAL);
        } else {
            IERC20(_collateral).approve(address(sportsAMM), 0);
        }
    }

    function retrieveFunds(IERC20 collateral, uint amount) external onlyOwner {
        collateral.safeTransfer(msg.sender, amount);
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /* ========== SETTERS ========== */

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
}
