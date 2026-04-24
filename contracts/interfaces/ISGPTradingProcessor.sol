// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ISportsAMMV2.sol";

interface ISGPTradingProcessor {
    struct SGPTradeData {
        ISportsAMMV2.TradeData[] _tradeData;
        uint _buyInAmount;
        uint _expectedQuote;
        uint _additionalSlippage;
        address _referrer;
        address _collateral;
        bool _isLive;
    }

    function maxAllowedExecutionDelay() external view returns (uint);

    function requestCounter() external view returns (uint);

    function counterToRequestId(uint _counter) external view returns (bytes32);

    function requestIdToRequester(bytes32 _requestId) external view returns (address);

    function requestIdToTicketId(bytes32 _requestId) external view returns (address);

    function requestIdFulfilled(bytes32 _requestId) external view returns (bool);

    function timestampPerRequest(bytes32 _requestId) external view returns (uint);

    function getTradeData(bytes32 _requestId) external view returns (SGPTradeData memory);

    function fulfillSGPTrade(bytes32 _requestId, bool allow, uint approvedAmount) external;

    function requestSGPTrade(SGPTradeData calldata _sgpTradeData) external returns (bytes32);
}
