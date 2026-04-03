// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "chainlink-vrf/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

contract MockVRFCoordinator {
    uint256 public lastRequestId;
    uint256 private nextRequestId = 1;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata /* req */) external returns (uint256 requestId) {
        requestId = nextRequestId;
        lastRequestId = requestId;
        nextRequestId++;
    }

    function fulfillRandomWords(address consumer, uint256 requestId, uint256[] calldata randomWords) external {
        (bool success, ) = consumer.call(
            abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", requestId, randomWords)
        );
        require(success, "MockVRFCoordinator: fulfillment failed");
    }
}
