// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Thales is ERC20, Ownable {
    string private __name = "Thales Token";
    string private __symbol = "THALES";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 100000000;

    uint public defaultAmount = 5000 * 1e6;

    function name() public view override returns (string memory) {
        return __name;
    }

    function symbol() public view override returns (string memory) {
        return __symbol;
    }

    function decimals() public pure override returns (uint8) {
        return __decimals;
    }

    constructor() ERC20(__name, __symbol) Ownable(msg.sender) {
        _mint(msg.sender, INITIAL_TOTAL_SUPPLY * 1e18);
    }

    function mintForUser(address _account) external {
        _mint(_account, defaultAmount);
    }

    function setDefaultAmount(uint _defaultAmount) external onlyOwner {
        require(defaultAmount != _defaultAmount && _defaultAmount > 0, "Value is zero or already set");
        defaultAmount = _defaultAmount;
        emit NewDefaultAmount(_defaultAmount);
    }

    event NewDefaultAmount(uint amount);
}
