// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract OvertimePaymentToken is ERC20 {
    string private __name = "Overtime Payment Token";
    string private __symbol = "OTP";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 1e7;

    constructor() ERC20(__name, __symbol) {
        _mint(msg.sender, INITIAL_TOTAL_SUPPLY * 1e18);
    }
}
