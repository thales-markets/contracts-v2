// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2Manager.sol";

contract MockStakingThales {
    mapping(address => uint) public volume;

    address public feeToken;

    function updateVolume(address account, uint amount) external {
        uint decimals = ISportsAMMV2Manager(feeToken).decimals();
        if (decimals == 6) {
            require(amount / 1e6 > 0 || amount == 0, "Did not receive 6 decimals update volume");
        } else if (decimals == 18) {
            require(amount / 1e18 > 0 || amount == 0, "Did not receive 18 decimals update volume");
        } else {
            require(amount > 0, "zero amount received");
        }
        volume[account] = amount;
    }

    function getFeeTokenDecimals() external view returns (uint feeTokenDecimals) {
        feeTokenDecimals = ISportsAMMV2Manager(feeToken).decimals();
    }

    function setFeeToken(address _feeToken) external {
        feeToken = _feeToken;
    }
}
