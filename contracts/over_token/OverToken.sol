// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract OverToken is ERC20 {
    string private __name = "Overtime DAO Token";
    string private __symbol = "OVER";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 69420000;

    constructor(address _treasury) ERC20(__name, __symbol) {
        _mint(_treasury, INITIAL_TOTAL_SUPPLY * 1e18);
    }
}
