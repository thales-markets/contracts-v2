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
    }

    function fulfillSGPTrade(bytes32 _requestId, bool allow, uint approvedAmount) external;

    function requestSGPTrade(SGPTradeData calldata _sgpTradeData) external returns (bytes32);
}
