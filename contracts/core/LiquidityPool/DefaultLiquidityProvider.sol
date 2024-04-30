// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";

contract DefaultLiquidityProvider is ProxyOwned, Initializable, ProxyReentrancyGuard {
    /* ========== LIBRARIES ========== */

    using SafeERC20 for IERC20;

    /* ========== CONST VARIABLES ========== */

    uint private constant MAX_APPROVAL = type(uint256).max;

    /* ========== STATE VARIABLES ========== */

    // the adddress of the LP contract
    address public liquidityPool;

    // the adddress of collateral that LP accepts
    IERC20 public collateral;

    function initialize(address _owner, address _liquidityPool, IERC20 _collateral) public initializer {
        setOwner(_owner);
        initNonReentrant();
        liquidityPool = _liquidityPool;
        collateral = _collateral;
        collateral.approve(liquidityPool, MAX_APPROVAL);
    }

    /// @notice stting the liquidity pool
    /// @param _liquidityPool the address of the LP contract
    function setLiquidityPool(address _liquidityPool) external onlyOwner {
        if (liquidityPool != address(0)) {
            collateral.approve(liquidityPool, 0);
        }
        liquidityPool = _liquidityPool;
        collateral.approve(_liquidityPool, MAX_APPROVAL);
        emit SetLiquidityPool(_liquidityPool);
    }

    /// @notice transfer collateral amount from contract to provided account
    /// @param _account the address of account for transfer
    /// @param _amount amount to transfer
    function retrieveCollateralAmount(address payable _account, uint _amount) external onlyOwner nonReentrant {
        collateral.safeTransfer(_account, _amount);
    }

    event SetLiquidityPool(address _liquidityPool);
}
