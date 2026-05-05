// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ExoticUSDC is ERC20, Ownable {
    string private __name = "Exotic USDC Token";
    string private __symbol = "eUSDC";
    uint8 private constant __decimals = 6;
    uint private constant INITIAL_TOTAL_SUPPLY = 100;

    bool public paused;
    uint public defaultAmount = 5000 * 1e6;

    mapping(address => bool) public isBlacklisted;

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
        _mint(msg.sender, INITIAL_TOTAL_SUPPLY * 1e6);
    }

    function mintForUser(address payable _account) external payable {
        require(!paused, "minting is paused");
        _mint(_account, defaultAmount);
        _account.transfer(msg.value);
    }

    function setName(string memory name_) external onlyOwner {
        __name = name_;
        emit NameChanged(name_);
    }

    function setSymbol(string memory symbol_) external onlyOwner {
        __symbol = symbol_;
        emit SymbolChanged(symbol_);
    }

    function setDefaultAmount(uint _defaultAmount) external onlyOwner {
        require(defaultAmount != _defaultAmount && _defaultAmount > 0, "Value is zero or already set");
        defaultAmount = _defaultAmount;
        emit NewDefaultAmount(_defaultAmount);
    }

    function setPaused(bool _paused) external onlyOwner {
        require(paused != _paused, "Pause already set to that value");
        paused = _paused;
        emit PausedChanged(_paused);
    }

    function setBlacklisted(address _account, bool _flag) external {
        isBlacklisted[_account] = _flag;
        emit BlacklistChanged(_account, _flag);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!isBlacklisted[from] && !isBlacklisted[to], "Address is blacklisted");
        super._update(from, to, value);
    }

    event NewDefaultAmount(uint amount);
    event PausedChanged(bool paused);
    event NameChanged(string name);
    event SymbolChanged(string symbol);
    event BlacklistChanged(address indexed account, bool flag);
}
