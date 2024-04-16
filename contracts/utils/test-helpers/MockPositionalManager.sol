// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2Manager.sol";

contract MockPositionalManager {
    bool public needsTransformingCollateral;

    function setTransformingCollateral(bool _needsTransformingCollateral) external {
        needsTransformingCollateral = _needsTransformingCollateral;
    }
}
