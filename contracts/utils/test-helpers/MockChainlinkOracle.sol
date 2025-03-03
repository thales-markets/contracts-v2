// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/IChainlinkResolver.sol";
import "../../interfaces/ISGPTradingProcessor.sol";

contract MockChainlinkOracle {
    address public liveTradingProcessor;
    address public sgpTradingProcessor;
    address public chainlinkResolver;

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

    function fulfillLiveTrade(bytes32 _requestId, bool allow, uint approvedAmount) external {
        ILiveTradingProcessor(liveTradingProcessor).fulfillLiveTrade(_requestId, allow, approvedAmount);
    }

    function fulfillMarketResolve(bytes32 _requestId, int24[][] calldata _results) external {
        IChainlinkResolver(chainlinkResolver).fulfillMarketResolve(_requestId, _results);
    }

    function fulfillSGPTrade(bytes32 _requestId, bool allow, uint approvedQuote) external {
        ISGPTradingProcessor(sgpTradingProcessor).fulfillSGPTrade(_requestId, allow, approvedQuote);
    }
}
