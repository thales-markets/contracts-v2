// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// internal
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../utils/proxy/ProxyReentrancyGuard.sol";

error AmountIsZero();

contract ExchangeThalesForOver is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    IERC20 public Thales;
    IERC20 public Over;

    function initialize(address _owner, address _thalesAddress, address _overAddress) external initializer {
        setOwner(_owner);
        initNonReentrant();

        Thales = IERC20(_thalesAddress);
        Over = IERC20(_overAddress);
    }

    function exchangeThalesForOver(uint _amount) external nonReentrant notPaused {
        if (_amount == 0) revert AmountIsZero();
        // burn Thales
        Thales.safeTransferFrom(msg.sender, BURN_ADDRESS, _amount);
        // send Over
        Over.safeTransfer(msg.sender, _amount);
    }

    function withdrawCollateral(address _collateral, uint _amount) external onlyOwner {
        IERC20(_collateral).safeTransfer(msg.sender, _amount);
    }

    function setThales(address _thalesAddress) external onlyOwner {
        Thales = IERC20(_thalesAddress);
    }

    function setOver(address _overAddress) external onlyOwner {
        Over = IERC20(_overAddress);
    }
}
