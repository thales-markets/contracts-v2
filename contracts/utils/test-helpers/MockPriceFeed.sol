// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

// external
contract MockPriceFeed {
    mapping(bytes32 => uint8) public currencyKeyDecimals;

    // List of currency keys for convenient iteration
    bytes32[] public currencyKeys;

    uint public priceForETHinUSD;

    constructor() {
        currencyKeys.push("ETH");
    }

    struct RateAndUpdatedTime {
        uint rate;
        uint40 time;
    }

    function getCurrencies() external view returns (bytes32[] memory) {
        return currencyKeys;
    }

    function rateForCurrency(bytes32 currencyKey) external view returns (uint) {
        return _getRateAndUpdatedTime(currencyKey).rate;
    }

    function setPriceForETH(uint _priceInUSD) external {
        priceForETHinUSD = _priceInUSD;
    }

    function _getRateAndUpdatedTime(bytes32 currencyKey) internal view returns (RateAndUpdatedTime memory) {
        require(currencyKey == currencyKeys[0], "Invalid key");
        return RateAndUpdatedTime({rate: priceForETHinUSD > 0 ? priceForETHinUSD : 3500, time: uint40(block.timestamp)});
    }
}
