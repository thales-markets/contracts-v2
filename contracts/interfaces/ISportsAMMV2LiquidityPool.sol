// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2LiquidityPool {
    function commitTrade(address ticket, uint amount) external;

    function transferToPool(address ticket, uint amount) external;

    function getTicketPool(address _ticket) external returns (address);

    function collateralKey() external view returns (bytes32);

    function getCollateralPrice() external view returns (uint);
}
