// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ThalesToken is ERC20, Ownable {
    string private __name = "Thales";
    string private __symbol = "THALES";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 100000000;

    /// @notice Returns the name of the token
    /// @return The name of the token as a string
    function name() public view override returns (string memory) {
        return __name;
    }

    /// @notice Returns the symbol of the token
    /// @return The symbol of the token as a string
    function symbol() public view override returns (string memory) {
        return __symbol;
    }

    /// @notice Returns the number of decimals used by the token
    /// @return The number of decimals (18)
    function decimals() public pure override returns (uint8) {
        return __decimals;
    }

    constructor(address _treasury) ERC20(__name, __symbol) Ownable(_treasury) {
        _mint(_treasury, INITIAL_TOTAL_SUPPLY * 1e18);
    }
}