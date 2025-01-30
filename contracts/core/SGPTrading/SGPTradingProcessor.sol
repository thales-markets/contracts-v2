// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "../../interfaces/ISGPTradingProcessor.sol";

contract SGPTradingProcessor is ChainlinkClient, Ownable, Pausable {
    using Strings for uint;
    using Strings for int256;
    using Strings for uint8;
    using Chainlink for Chainlink.Request;
    using SafeERC20 for IERC20;

    uint private constant ONE = 1e18;

    ISportsAMMV2 public sportsAMM;

    address freeBetsHolder;

    bytes32 public jobSpecId;

    uint public paymentAmount;

    uint public maxAllowedExecutionDelay = 60;

    mapping(bytes32 => ISGPTradingProcessor.SGPTradeData) public requestIdToTradeData;
    mapping(bytes32 => address) public requestIdToRequester;
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

    /// @notice requests SGP trade
    /// @param _sgpTradeData for which to request a sgp trade
    function requestSGPTrade(
        ISGPTradingProcessor.SGPTradeData calldata _sgpTradeData
    ) external whenNotPaused returns (bytes32 requestId) {
        uint numOfMarkets = _sgpTradeData._tradeData.length;
        require(numOfMarkets > 1, "SGP not possible for a single game");

        Chainlink.Request memory req;

        req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillSGPTrade.selector);

        string[] memory gameIds = new string[](numOfMarkets);
        string[] memory typeIds = new string[](numOfMarkets);
        string[] memory playerIds = new string[](numOfMarkets);
        string[] memory lines = new string[](numOfMarkets);
        string[] memory positions = new string[](numOfMarkets);

        for (uint i = 0; i < numOfMarkets; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _sgpTradeData._tradeData[i];
            gameIds[i] = bytes32ToString(marketTradeData.gameId);
            typeIds[i] = uint256(marketTradeData.typeId).toString();
            playerIds[i] = uint256(marketTradeData.playerId).toString();
            lines[i] = int256(marketTradeData.line).toStringSigned();
            positions[i] = uint256(marketTradeData.position).toString();
        }

        req.addStringArray("gameIds", gameIds);
        req.addStringArray("typeIds", typeIds);
        req.addStringArray("playerIds", playerIds);
        req.addStringArray("positions", positions);
        req.addStringArray("lines", lines);
        req.addUint("buyInAmount", _sgpTradeData._buyInAmount);
        req.addUint("expectedQuote", _sgpTradeData._expectedQuote);
        req.addUint("additionalSlippage", _sgpTradeData._additionalSlippage);

        requestId = sendChainlinkRequest(req, paymentAmount);
        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTradeData[requestId] = _sgpTradeData;
        requestIdToRequester[requestId] = msg.sender;

        counterToRequestId[requestCounter] = requestId;

        emit SGPTradeRequested(msg.sender, requestCounter, requestId, _sgpTradeData);
        requestCounter++;
    }

    /// @notice fulfillSGPTrade
    /// @param _requestId which is being fulfilled
    /// @param _allow whether the live trade should go through
    /// @param _approvedQuote what will be the actual payout
    function fulfillSGPTrade(
        bytes32 _requestId,
        bool _allow,
        uint _approvedQuote
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        //might be redundant as already done by Chainlink Client, but making double sure
        require(!requestIdFulfilled[_requestId], "Request ID already fulfilled");
        require((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) > block.timestamp, "Request timed out");

        ISGPTradingProcessor.SGPTradeData memory sgpTradeData = requestIdToTradeData[_requestId];
        address requester = requestIdToRequester[_requestId];

        require(
            ((ONE * _approvedQuote) / sgpTradeData._expectedQuote) <= (ONE + sgpTradeData._additionalSlippage),
            "Slippage too high"
        );

        if (_allow) {
            address _createdTicket = sportsAMM.tradeSGP(
                sgpTradeData._tradeData,
                sgpTradeData._buyInAmount,
                _approvedQuote,
                requester,
                sgpTradeData._referrer,
                sgpTradeData._collateral
            );

            if (requester == freeBetsHolder) {
                IFreeBetsHolder(freeBetsHolder).confirmSGPTrade(
                    _requestId,
                    _createdTicket,
                    sgpTradeData._buyInAmount,
                    sgpTradeData._collateral
                );
            }
        }
        requestIdToFulfillAllowed[_requestId] = _allow;
        requestIdFulfilled[_requestId] = true;

        emit SGPTradeFulfilled(requester, _requestId, _allow, sgpTradeData, _approvedQuote, block.timestamp);
    }

    /// @notice withdraw collateral in the contract
    /// @param collateral the collateral address
    /// @param recipient the recipient of the collateral
    function withdrawCollateral(address collateral, address recipient) external onlyOwner {
        IERC20(collateral).safeTransfer(recipient, IERC20(collateral).balanceOf(address(this)));
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

    /// @notice sets the FreeBetsHolder address, required for handling ticket claiming via FreeBetsHolder
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    /// @notice setMaxAllowedExecutionDelay
    /// @param _maxAllowedExecutionDelay maximum allowed buffer for the CL request to be executed, defaulted at 60 seconds
    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    // Helper function to convert bytes32 to string
    function bytes32ToString(bytes32 _bytes32) internal pure returns (string memory) {
        uint8 i = 0;
        while (i < 32 && _bytes32[i] != 0) {
            i++;
        }
        bytes memory bytesArray = new bytes(i);
        for (uint8 j = 0; j < i; j++) {
            bytesArray[j] = _bytes32[j];
        }
        return string(bytesArray);
    }

    /////// EVENTS
    event ContextReset(address _link, address _oracle, address _sportsAMM, bytes32 _jobSpecId, uint _paymentAmount);
    event SGPTradeRequested(
        address requester,
        uint requestCounter,
        bytes32 requestId,
        ISGPTradingProcessor.SGPTradeData sgpTradeData
    );
    event SGPTradeFulfilled(
        address requester,
        bytes32 requestId,
        bool _allow,
        ISGPTradingProcessor.SGPTradeData sgpTradeData,
        uint _approvedQuote,
        uint timestamp
    );
    event SetMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay);
    event SetFreeBetsHolder(address _freeBetsHolder);
}
