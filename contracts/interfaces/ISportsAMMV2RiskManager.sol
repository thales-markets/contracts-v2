// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2RiskManager {
    function calculateCapToBeUsed(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _maturity
    ) external view returns (uint cap);

    function isTotalSpendingLessThanTotalRisk(
        uint _totalSpent,
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _maturity
    ) external view returns (bool _isNotRisky);
}
