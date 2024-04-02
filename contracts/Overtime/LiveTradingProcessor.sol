// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/ISportsAMMV2.sol";

contract LiveTradingProcessor is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;
    using SafeERC20 for IERC20;

    uint private constant ONE = 1e18;

    ISportsAMMV2 public sportsAMM;

    bytes32 public jobSpecId;

    uint public paymentAmount;

    uint maxAllowedExecutionDelay = 60;

    struct LiveTradeData {
        address requester;
        bytes32 _gameId;
        uint16 _sportId;
        uint8 position;
        uint _buyInAmount;
        uint _expectedPayout;
        uint _additionalSlippage;
        address _differentRecipient;
        address _referrer;
        address _collateral;
    }

    mapping(bytes32 => LiveTradeData) public requestIdToTradeData;
    mapping(bytes32 => bool) public requestIdToFulfillAllowed;
    mapping(bytes32 => bool) public requestIdFulfilled;
    mapping(bytes32 => uint) public timestampPerRequest;

    uint public requestCounter;
    mapping(uint => bytes32) public counterToRequestId;

    constructor(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        uint _paymentAmount
    ) Ownable(msg.sender) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        sportsAMM = ISportsAMMV2(_sportsAMM);
        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;
    }

    /// @notice requestLiveTrade
    /// @param _gameId for which to request a live trade
    /// @param _sportId for which to request a live trade
    /// @param _position for which to request a live trade
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedPayout expected payout
    /// @param _additionalSlippage the maximum slippage a user will accept
    /// @param _referrer who should get the referrer fee if any
    /// @param _collateral different collateral used for paymentAmount
    function requestLiveTrade(
        bytes32 _gameId,
        uint16 _sportId,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient, // in case a voucher is used
        address _referrer,
        address _collateral
    ) external whenNotPaused {
        require(sportsAMM.riskManager().liveTradingPerSportEnabled(_sportId), "Live trading not enabled on _sportId");

        Chainlink.Request memory req;

        req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillLiveTrade.selector);

        req.add("_gameId", string(abi.encodePacked(_gameId)));
        req.addUint("_sportId", _sportId);
        req.addUint("_buyInAmount", _buyInAmount);
        req.addUint("_expectedPayout", _expectedPayout);
        req.addUint("_additionalSlippage", _additionalSlippage);

        if (_differentRecipient == address(0)) {
            _differentRecipient = msg.sender;
        }

        bytes32 requestId = sendChainlinkRequest(req, paymentAmount);
        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTradeData[requestId] = LiveTradeData(
            msg.sender,
            _gameId,
            _sportId,
            _position,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            _differentRecipient,
            _referrer,
            _collateral
        );

        counterToRequestId[requestCounter] = requestId;

        emit LiveTradeRequested(
            msg.sender,
            requestCounter,
            requestId,
            _gameId,
            _sportId,
            _position,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            _differentRecipient,
            _referrer,
            _collateral
        );
        requestCounter++;
    }

    /// @notice fulfillLiveTrade
    /// @param _requestId which is being fulfilled
    /// @param _allow whether the live trade should go through
    /// @param _approvedPayoutAmount what will be the actual payout
    function fulfillLiveTrade(
        bytes32 _requestId,
        bool _allow,
        uint _approvedPayoutAmount
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        //might be redundant as already done by Chainlink Client, but making double sure
        require(!requestIdToFulfillAllowed[_requestId], "Request ID already fulfilled");
        require((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) > block.timestamp, "Request timed out");

        LiveTradeData memory lTradeData = requestIdToTradeData[_requestId];

        require(
            ((ONE * lTradeData._expectedPayout) / _approvedPayoutAmount) <= (ONE + lTradeData._additionalSlippage),
            "Slippage too high"
        );

        if (_allow) {
            ISportsAMMV2.TradeData[] memory tradeData = new ISportsAMMV2.TradeData[](1);
            bytes32[] memory merkleProofs;
            uint[] memory odds = new uint[](3);
            ISportsAMMV2.CombinedPosition[][] memory comPositions = new ISportsAMMV2.CombinedPosition[][](3);

            tradeData[0] = ISportsAMMV2.TradeData(
                lTradeData._gameId,
                lTradeData._sportId,
                0, //type, set moneyline
                block.timestamp + 60, //maturity, hardcode to timestamp with buffer
                0, //status
                0, //line
                0, //playerId
                odds, //odds[]
                merkleProofs, //merkleProof[]
                lTradeData.position,
                comPositions //combinedPositions[]
            );

            sportsAMM.tradeLive(
                tradeData,
                lTradeData.requester,
                lTradeData._buyInAmount,
                _approvedPayoutAmount,
                lTradeData._differentRecipient,
                lTradeData._referrer,
                lTradeData._collateral
            );
        }
        requestIdToFulfillAllowed[_requestId] = _allow;
        requestIdFulfilled[_requestId] = true;

        emit LiveTradeFulfilled(
            lTradeData._differentRecipient,
            _requestId,
            _allow,
            lTradeData._gameId,
            lTradeData._sportId,
            lTradeData.position,
            lTradeData._buyInAmount,
            lTradeData._expectedPayout,
            lTradeData._additionalSlippage,
            lTradeData._referrer,
            lTradeData._collateral,
            block.timestamp
        );
    }

    //////////// SETTERS

    /// @notice pause live trading
    /// @param _setPausing whether to pause or unpause
    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /// @notice setConfiguration
    /// @param _link paymentAmount token
    /// @param _oracle CL node that will execute the requests
    /// @param _sportsAMM address
    /// @param _jobSpecId CL node job spec ID
    /// @param _paymentAmount amount of paymentAmount token for each request
    function setConfiguration(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        uint _paymentAmount
    ) external onlyOwner {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        sportsAMM = ISportsAMMV2(_sportsAMM);
        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;

        emit ContextReset(_link, _oracle, _sportsAMM, _jobSpecId, _paymentAmount);
    }

    /// @notice setMaxAllowedExecutionDelay
    /// @param _maxAllowedExecutionDelay maximum allowed buffer for the CL request to be executed, defaulted at 60 seconds
    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    /////// EVENTS
    event ContextReset(address _link, address _oracle, address _sportsAMM, bytes32 _jobSpecId, uint _paymentAmount);
    event LiveTradeRequested(
        address sender,
        uint requestCounter,
        bytes32 requestId,
        bytes32 _gameId,
        uint16 _sportId,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address _collateral
    );
    event LiveTradeFulfilled(
        address recipient,
        bytes32 requestId,
        bool _allow,
        bytes32 _gameId,
        uint16 _sportId,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        uint timestamp
    );
    event SetMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay);
}
