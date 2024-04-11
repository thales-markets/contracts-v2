// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@thales-dao/contracts/contracts/interfaces/IPriceFeed.sol";

interface IPriceFeedExtension is IPriceFeed {
    function transformCollateral(address _collateral, uint _collateralAmount) external view returns (uint amountInUSD);
}
