// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILiveTradingProcessor {
    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedAmount) external;

    function requestLiveTrade(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address _collateral
    ) external returns (bytes32);
}
