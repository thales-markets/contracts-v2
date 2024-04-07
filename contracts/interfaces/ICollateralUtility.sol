// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICollateralUtility {
    function deposit() external payable;

    function withdraw(uint256) external;

    function priceFeed() external view returns (address);

    function commitTrade(address ticket, uint amount) external;

    function getAddress(string calldata _contractName) external view returns (address);

    function rateForCurrency(bytes32 currencyKey) external view returns (uint);
}
