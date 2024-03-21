// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ILiveTradingProcessor.sol";

contract MockChainlinkOracle {
    address public liveTradingProcessor;

    constructor() {}

    function setLiveTradingProcessor(address _liveTradingProcessor) external {
        liveTradingProcessor = _liveTradingProcessor;
    }

    function fulfillLiveTrade(bytes32 _requestId, bool allow) external {
        ILiveTradingProcessor(liveTradingProcessor).fulfillLiveTrade(_requestId, allow);
    }
}
