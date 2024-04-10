// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IChainlinkResolver {
    function fulfillMarketResolve(bytes32 _requestId, int24[][] calldata _results) external;
}
