// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// internal
import "../../utils/proxy/ProxyOwned.sol";

contract SafeBox is Initializable, ProxyOwned {
    using SafeERC20 for IERC20;

    function initialize(address _owner) external initializer {
        setOwner(_owner);
    }

    /// @notice Allows the owner to withdraw any ERC20 tokens from the contract
    /// @param _collateral The address of the ERC20 token to withdraw
    /// @param _recipient The address of the recipient
    /// @param _amount The amount of tokens to withdraw
    function withdrawCollateral(address _collateral, address _recipient, uint _amount) external onlyOwner {
        address recipient = _recipient == address(0) ? owner : _recipient;
        IERC20(_collateral).safeTransfer(recipient, _amount);
        emit WithdrawnCollateral(_collateral, recipient, _amount);
    }

    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint amount);
}
