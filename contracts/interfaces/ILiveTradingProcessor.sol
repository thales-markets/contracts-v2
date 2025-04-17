// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILiveTradingProcessor {
    struct LiveTradeData {
        string _gameId;
        uint16 _sportId;
        uint16 _typeId;
        int24 _line;
        uint8 _position;
        uint _buyInAmount;
        uint _expectedQuote;
        uint _additionalSlippage;
        address _referrer;
        address _collateral;
    }

    function maxAllowedExecutionDelay() external view returns (uint);

    function requestCounter() external view returns (uint);

    function counterToRequestId(uint _counter) external view returns (bytes32);

    function requestIdToRequester(bytes32 _requestId) external view returns (address);

    function requestIdFulfilled(bytes32 _requestId) external view returns (bool);

    function timestampPerRequest(bytes32 _requestId) external view returns (uint);

    // in order to return struct instead of tuple add getter for requestIdToTradeData to LiveTradingProcessor
    function requestIdToTradeData(
        bytes32 _requestId
    ) external view returns (string memory, uint16, uint16, int24, uint8, uint);

    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedAmount) external;

    function requestLiveTrade(LiveTradeData calldata _liveTradeData) external returns (bytes32);
}
