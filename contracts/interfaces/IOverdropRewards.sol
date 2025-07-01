// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOverdropRewards {

    function hasClaimedRewards(address account) external view returns (bool);
    function remainingRewards() external view returns (uint256);
    function verifyProof(address account, uint256 amount, bytes32[] calldata merkleProof) external view returns (bool);
} 