// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILiveTradingProcessor {
    struct LiveTradeData {
        bytes32 _gameId;
        uint16 _sportId;
        uint16 _typeId;
        int24 _line;
        uint8 _position;
        uint _buyInAmount;
        uint _expectedQuote;
        uint _additionalSlippage;
        address _differentRecipient; //TODO: should be removed
        address _referrer;
        address _collateral;
    }

    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedAmount) external;

    function requestLiveTrade(LiveTradeData calldata _liveTradeData) external returns (bytes32);
}
