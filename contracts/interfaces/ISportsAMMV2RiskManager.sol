// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2RiskManager {
    struct TypeCap {
        uint typeId;
        uint cap;
    }

    struct CapData {
        uint capPerSport;
        uint capPerChild;
        TypeCap[] capPerType;
    }

    struct DynamicLiquidityData {
        uint cutoffTimePerSport;
        uint cutoffDividerPerSport;
    }

    struct RiskData {
        uint sportId;
        CapData capData;
        uint riskMultiplierPerSport;
        DynamicLiquidityData dynamicLiquidityData;
    }

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

    function liveTradingPerSportAndTypeEnabled(uint _sportId, uint _typeId) external view returns (bool _enabled);
}
