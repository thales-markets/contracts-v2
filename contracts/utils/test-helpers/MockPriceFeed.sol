// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

// external
contract MockPriceFeed {
    mapping(bytes32 => uint8) public currencyKeyDecimals;

    // List of currency keys for convenient iteration
    bytes32[] public currencyKeys;

    address public WETH9;

    uint public priceForETHinUSD;
    uint public defaultCollateralDecimals;

    mapping(address => uint) public collateralPriceInUSD;
    mapping(bytes32 => address) public collateralAddressForKey;

    constructor() {
        currencyKeys.push("ETH");
        priceForETHinUSD = 3500 * 1e18;
    }

    struct RateAndUpdatedTime {
        uint rate;
        uint40 time;
    }

    function getCurrencies() external view returns (bytes32[] memory) {
        return currencyKeys;
    }

    function getRates() external view returns (uint[] memory rates) {
        rates = new uint[](currencyKeys.length);
        for (uint i = 0; i < currencyKeys.length; i++) {
            bytes32 currencyKey = currencyKeys[i];
            rates[i] = _getRateAndUpdatedTime(currencyKey).rate;
        }
    }

    function rateForCurrency(bytes32 currencyKey) external view returns (uint) {
        return _getRateAndUpdatedTime(currencyKey).rate;
    }

    function transformCollateral(address _collateral, uint _collateralAmount) external view returns (uint amountInUSD) {
        amountInUSD = (_collateralAmount * collateralPriceInUSD[_collateral]) / (10 ** (18 - defaultCollateralDecimals));
    }

    function setPriceFeedForCollateral(bytes32 _collateralKey, address _collateral, uint _priceInUSD) external {
        currencyKeys.push(_collateralKey);
        collateralAddressForKey[_collateralKey] = _collateral;
        collateralPriceInUSD[_collateral] = _priceInUSD;
    }

    function setWETH9(address _WETH9) external {
        WETH9 = _WETH9;
    }

    function setPriceForETH(uint _priceInUSD) external {
        priceForETHinUSD = _priceInUSD;
    }

    function setDefaultCollateralDecimals(uint _decimals) external {
        defaultCollateralDecimals = _decimals;
    }

    function _getRateAndUpdatedTime(bytes32 currencyKey) internal view returns (RateAndUpdatedTime memory) {
        require(collateralAddressForKey[currencyKey] != address(0) || currencyKey == currencyKeys[0], "Invalid key");
        if (currencyKey == currencyKeys[0]) {
            return RateAndUpdatedTime({rate: priceForETHinUSD, time: uint40(block.timestamp)});
        } else {
            return
                RateAndUpdatedTime({
                    rate: collateralPriceInUSD[collateralAddressForKey[currencyKey]],
                    time: uint40(block.timestamp)
                });
        }
    }
}
