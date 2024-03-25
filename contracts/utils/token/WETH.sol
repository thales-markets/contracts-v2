// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WETH9 is ERC20, Ownable {
    string private __name = "Wrapped Ether";
    string private __symbol = "WETH";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 100;

    bool public paused;

    function name() public view override returns (string memory) {
        return __name;
    }

    function symbol() public view override returns (string memory) {
        return __symbol;
    }

    function decimals() public pure override returns (uint8) {
        return __decimals;
    }

    constructor() ERC20(__name, __symbol) Ownable(msg.sender) {}

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint wad) public {
        require(balanceOf(msg.sender) >= wad);
        _burn(msg.sender, wad);
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    receive() external payable {
        deposit();
    }

    fallback() external payable {}

    function setName(string memory name_) external onlyOwner {
        __name = name_;
        emit NameChanged(name_);
    }

    function setSymbol(string memory symbol_) external onlyOwner {
        __symbol = symbol_;
        emit SymbolChanged(symbol_);
    }

    function setPaused(bool _paused) external onlyOwner {
        require(paused != _paused, "Pause already set to that value");
        paused = _paused;
        emit PausedChanged(_paused);
    }

    event PausedChanged(bool paused);
    event NameChanged(string name);
    event SymbolChanged(string symbol);
    event Deposit(address indexed dst, uint wad);
    event Withdrawal(address indexed src, uint wad);
}
