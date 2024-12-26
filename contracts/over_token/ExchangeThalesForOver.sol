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

    /// @notice Exchanges Thales tokens for Over tokens at a 1:1 ratio
    /// @param _amount The amount of Thales tokens to exchange for Over tokens
    /// @dev Burns the Thales tokens and transfers an equal amount of Over tokens to the sender
    function exchangeThalesForOver(uint _amount) external nonReentrant notPaused {
        if (_amount == 0) revert AmountIsZero();
        // burn Thales
        Thales.safeTransferFrom(msg.sender, BURN_ADDRESS, _amount);
        // send Over
        Over.safeTransfer(msg.sender, _amount);

        emit ThalesToOverExchanged(msg.sender, _amount);
    }

    /// @notice Allows the owner to withdraw any ERC20 tokens from the contract
    /// @param _collateral The address of the ERC20 token to withdraw
    /// @param _amount The amount of tokens to withdraw
    function withdrawCollateral(address _collateral, uint _amount) external onlyOwner {
        IERC20(_collateral).safeTransfer(msg.sender, _amount);
        emit WithdrawnCollateral(_collateral, _amount);
    }

    /// @notice Updates the Thales token contract address
    /// @param _thalesAddress The new Thales token contract address
    function setThales(address _thalesAddress) external onlyOwner {
        Thales = IERC20(_thalesAddress);
        emit SetThales(_thalesAddress);
    }

    /// @notice Updates the Over token contract address
    /// @param _overAddress The new Over token contract address
    function setOver(address _overAddress) external onlyOwner {
        Over = IERC20(_overAddress);
        emit SetOver(_overAddress);
    }

    event ThalesToOverExchanged(address indexed user, uint amount);
    event SetThales(address indexed thalesAddress);
    event SetOver(address indexed overAddress);
    event WithdrawnCollateral(address indexed collateral, uint amount);
}
