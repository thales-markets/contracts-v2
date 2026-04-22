// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2LiquidityPool {
    function commitTrade(address ticket, uint amount) external;

    function commitTradeDeferred(address ticket, uint buyInAmount) external;

    function provideForResolution(address ticket, uint amount) external;

    function transferToPool(address ticket, uint amount) external;

    function getTicketPool(address _ticket) external returns (address);

    function getTicketRound(address _ticket) external view returns (uint);

    function collateralKey() external view returns (bytes32);

    function getCollateralPrice() external view returns (uint);
}
