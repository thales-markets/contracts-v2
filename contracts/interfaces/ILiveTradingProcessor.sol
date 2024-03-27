// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILiveTradingProcessor {
    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedAmount) external;
}
