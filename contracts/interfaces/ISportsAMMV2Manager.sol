// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2Manager {
    function isWhitelistedAddress(address _address) external view returns (bool);
}
