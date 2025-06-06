// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ISportsAMMV2.sol";

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

    enum RiskStatus {
        NoRisk,
        OutOfLiquidity,
        InvalidCombination
    }

    function minBuyInAmount() external view returns (uint);

    function maxTicketSize() external view returns (uint);

    function maxSupportedAmount() external view returns (uint);

    function maxSupportedOdds() external view returns (uint);

    function maxAllowedSystemCombinations() external view returns (uint);

    function expiryDuration() external view returns (uint);

    function liveTradingPerSportAndTypeEnabled(uint _sportId, uint _typeId) external view returns (bool _enabled);

    function calculateCapToBeUsed(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        uint _maturity,
        bool _isLive
    ) external view returns (uint cap);

    function checkRisks(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount,
        bool _isLive,
        uint8 _systemBetDenominator
    ) external view returns (ISportsAMMV2RiskManager.RiskStatus riskStatus, bool[] memory isMarketOutOfLiquidity);

    function checkLimits(
        uint _buyInAmount,
        uint _totalQuote,
        uint _payout,
        uint _expectedPayout,
        uint _additionalSlippage,
        uint _ticketSize
    ) external view;

    function spentOnGame(bytes32 _gameId) external view returns (uint);

    function riskPerMarketTypeAndPosition(
        bytes32 _gameId,
        uint _typeId,
        uint _playerId,
        uint _position
    ) external view returns (int);

    function checkAndUpdateRisks(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount,
        uint _payout,
        bool _isLive,
        uint8 _systemBetDenominator,
        bool _isSGP
    ) external;

    function verifyMerkleTree(ISportsAMMV2.TradeData memory _marketTradeData, bytes32 _rootPerGame) external pure;

    function batchVerifyMerkleTree(
        ISportsAMMV2.TradeData[] memory _marketTradeData,
        bytes32[] memory _rootPerGame
    ) external pure;

    function isSportIdFuture(uint16 _sportsId) external view returns (bool);

    function sgpOnSportIdEnabled(uint16 _sportsId) external view returns (bool);

    function getMaxSystemBetPayout(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint8 _systemBetDenominator,
        uint _buyInAmount,
        uint _addedPayoutPercentage
    ) external view returns (uint systemBetPayout, uint systemBetQuote);

    function generateCombinations(uint8 n, uint8 k) external pure returns (uint8[][] memory);
}
