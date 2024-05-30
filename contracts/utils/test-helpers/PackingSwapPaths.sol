// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

contract PackingSwapPaths {
    function getEncodedPacked(
        address inToken,
        uint24 feeIn,
        address[] memory proxies,
        uint24[] memory feesOut,
        address target
    ) external pure returns (bytes memory encoded) {
        if (proxies.length > 0) {
            require(proxies.length == feesOut.length, "Proxies and fees have different length");
            bytes memory proxiesPacked;
            for (uint i = 0; i < proxies.length; i++) {
                proxiesPacked = abi.encodePacked(proxiesPacked, proxies[i], feesOut[i]);
            }
            encoded = abi.encodePacked(inToken, feeIn, proxiesPacked, target);
        } else {
            require(feesOut.length > 0, "feesOut[0] is missing");
            encoded = abi.encodePacked(inToken, feesOut[0], target);
        }
    }
}
