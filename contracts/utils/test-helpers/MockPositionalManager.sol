// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2Manager.sol";

contract MockPositionalManager {
    bool public needsTransformingCollateral;

    function setTransformingCollateral(bool _needsTransformingCollateral) external {
        needsTransformingCollateral = _needsTransformingCollateral;
    }

    /// @notice transformCollateral transforms collateral
    /// @param value value to be transformed
    /// @return uint
    function transformCollateral(uint value) external view returns (uint) {
        if (needsTransformingCollateral) {
            return value / 1e12;
        } else {
            return value;
        }
    }

    /// @notice reverseTransformCollateral reverse collateral if needed
    /// @param value value to be reversed
    /// @return uint
    function reverseTransformCollateral(uint value) external view returns (uint) {
        if (needsTransformingCollateral) {
            return value * 1e12;
        } else {
            return value;
        }
    }
}
