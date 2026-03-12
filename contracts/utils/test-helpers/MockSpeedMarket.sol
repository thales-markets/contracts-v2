// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockSpeedMarket {
    bool public isUserWinner;

    constructor(bool _isUserWinner) {
        isUserWinner = _isUserWinner;
    }

    function setIsUserWinner(bool _isUserWinner) external {
        isUserWinner = _isUserWinner;
    }
}
