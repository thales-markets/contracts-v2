// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Over is ERC20, Ownable {
    string private __name = "OVERtime Token";
    string private __symbol = "OVER";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 69420000;

    function name() public view override returns (string memory) {
        return __name;
    }

    function symbol() public view override returns (string memory) {
        return __symbol;
    }

    function decimals() public pure override returns (uint8) {
        return __decimals;
    }

    constructor(address _treasury) ERC20(__name, __symbol) Ownable(_treasury) {
        _mint(_treasury, INITIAL_TOTAL_SUPPLY * 1e18);
    }
}
