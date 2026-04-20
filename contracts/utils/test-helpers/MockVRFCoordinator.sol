// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "chainlink-vrf/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/// @dev Mirrors the real Chainlink VRFCoordinatorV2_5's reentrancy guard behaviour:
/// `requestRandomWords` is nonReentrant AND fulfillRandomWords sets the lock while
/// invoking the consumer callback. A consumer that tries to request more randomness
/// from inside its callback will revert with `Reentrant()` — same as on mainnet.
contract MockVRFCoordinator {
    error Reentrant();

    uint256 public lastRequestId;
    uint256 private nextRequestId = 1;
    bool private reentrancyLock;

    modifier nonReentrant() {
        if (reentrancyLock) revert Reentrant();
        _;
    }

    function requestRandomWords(
        VRFV2PlusClient.RandomWordsRequest calldata /* req */
    ) external nonReentrant returns (uint256 requestId) {
        requestId = nextRequestId;
        lastRequestId = requestId;
        nextRequestId++;
    }

    function fulfillRandomWords(address consumer, uint256 requestId, uint256[] calldata randomWords) external {
        reentrancyLock = true;
        (bool success, ) = consumer.call(
            abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", requestId, randomWords)
        );
        reentrancyLock = false;
        require(success, "MockVRFCoordinator: fulfillment failed");
    }
}
