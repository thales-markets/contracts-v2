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
        uint24 _playerId; // player props
    }

    struct LiveParlayLeg {
        string gameId;
        uint16 sportId;
        uint16 typeId;
        int24 line;
        uint8 position;
        uint expectedLegOdd; // optional; node-side hint
        uint24 playerId;
    }

    struct LiveParlayTradeData {
        LiveParlayLeg[] legs;
        uint buyInAmount;
        uint expectedPayout;
        uint additionalSlippage;
        address referrer;
        address collateral;
    }

    // =========================
    // Views
    // =========================

    function maxAllowedExecutionDelay() external view returns (uint);

    function requestCounter() external view returns (uint);

    function counterToRequestId(uint _counter) external view returns (bytes32);

    function requestIdToRequester(bytes32 _requestId) external view returns (address);

    function requestIdToTicketId(bytes32 _requestId) external view returns (address);

    function requestIdFulfilled(bytes32 _requestId) external view returns (bool);

    function timestampPerRequest(bytes32 _requestId) external view returns (uint);

    function getTradeData(bytes32 _requestId) external view returns (LiveTradeData memory);

    function getParlayTradeData(bytes32 _requestId) external view returns (LiveParlayTradeData memory);

    // =========================
    // Actions
    // =========================

    function requestLiveTrade(LiveTradeData calldata _liveTradeData) external returns (bytes32);

    function requestLiveParlayTrade(LiveParlayTradeData calldata _parlay) external returns (bytes32);

    /**
     * @notice SINGLE fulfill (backwards-compatible with production)
     */
    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedQuote) external;

    /**
     * @notice PARLAY fulfill (new)
     * @dev approvedLegOdds.length must equal number of legs
     */
    function fulfillLiveTradeParlay(
        bytes32 _requestId,
        bool allow,
        uint approvedQuote,
        uint[] calldata approvedLegOdds
    ) external;
}
