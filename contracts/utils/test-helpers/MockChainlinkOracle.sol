// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/IChainlinkResolver.sol";
import "../../interfaces/ISGPTradingProcessor.sol";

interface ICashoutProcessor {
    function fulfillCashout(bytes32 requestId, bool allow, uint[] calldata approvedOddsPerLeg) external;
}

contract MockChainlinkOracle {
    address public liveTradingProcessor;
    address public sgpTradingProcessor;
    address public chainlinkResolver;
    address public cashoutProcessor;

    constructor() {}

    function setLiveTradingProcessor(address _liveTradingProcessor) external {
        liveTradingProcessor = _liveTradingProcessor;
    }

    function setSGPTradingProcessor(address _sgpTradingProcessor) external {
        sgpTradingProcessor = _sgpTradingProcessor;
    }

    function setChainlinkResolver(address _chainlinkResolver) external {
        chainlinkResolver = _chainlinkResolver;
    }

    function setCashoutProcessor(address _cashoutProcessor) external {
        cashoutProcessor = _cashoutProcessor;
    }

    // =========================
    // LiveTradingProcessor fulfill mocks
    // =========================

    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedQuote) external {
        ILiveTradingProcessor(liveTradingProcessor).fulfillLiveTrade(_requestId, allow, approvedQuote);
    }

    function fulfillLiveTradeParlay(
        bytes32 _requestId,
        bool allow,
        uint approvedQuote,
        uint[] calldata approvedLegOdds
    ) external {
        ILiveTradingProcessor(liveTradingProcessor).fulfillLiveTradeParlay(
            _requestId,
            allow,
            approvedQuote,
            approvedLegOdds
        );
    }

    // =========================
    // Other mocks
    // =========================

    function fulfillMarketResolve(bytes32 _requestId, int24[][] calldata _results) external {
        IChainlinkResolver(chainlinkResolver).fulfillMarketResolve(_requestId, _results);
    }

    function fulfillSGPTrade(bytes32 _requestId, bool allow, uint approvedQuote) external {
        ISGPTradingProcessor(sgpTradingProcessor).fulfillSGPTrade(_requestId, allow, approvedQuote);
    }

    function fulfillCashout(bytes32 _requestId, bool allow, uint[] calldata approvedOddsPerLeg) external {
        ICashoutProcessor(cashoutProcessor).fulfillCashout(_requestId, allow, approvedOddsPerLeg);
    }
}
