// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

contract MockStakingThales {
    mapping(address => uint) public volume;

    address public feeToken;

    function updateVolume(address account, uint amount) external {
        volume[account] = amount;
    }

    function setFeeToken(address _feeToken) external {
        feeToken = _feeToken;
    }
}
