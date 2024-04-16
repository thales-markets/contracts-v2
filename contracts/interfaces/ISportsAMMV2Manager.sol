// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2Manager {
    enum Role {
        ROOT_SETTING,
        RISK_MANAGING,
        MARKET_RESOLVING
    }

    function isWhitelistedAddress(address _address, Role role) external view returns (bool);

    function transformCollateral(uint value, address collateral) external view returns (uint);

    function reverseTransformCollateral(uint value, address collateral) external view returns (uint);

    function decimals() external view returns (uint);

    function feeToken() external view returns (address);

    function manager() external view returns (address);

    function needsTransformingCollateral() external view returns (bool);
}
