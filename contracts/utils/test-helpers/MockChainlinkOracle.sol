// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/IChainlinkResolver.sol";

contract MockChainlinkOracle {
    address public liveTradingProcessor;
    address public chainlinkResolver;

    constructor() {}

    function setLiveTradingProcessor(address _liveTradingProcessor) external {
        liveTradingProcessor = _liveTradingProcessor;
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
}
