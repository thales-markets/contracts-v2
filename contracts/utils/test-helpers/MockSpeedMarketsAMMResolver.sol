// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../../interfaces/IFreeBetsHolder.sol";


contract MockSpeedMarketsAMMResolver {
    address public addressManager;
    address public speedMarketsAMM;
    address public chainedSpeedMarketsAMM;
    
    mapping(address => address) public marketToFreeBetsHolder;
    
    uint private constant ONE = 1e18;
    
    // Dummy variables for testing
    uint public dummyBuyInAmount = 100e18;
    address public dummyCollateral = 0x0000000000000000000000000000000000000001;
    uint public dummyPayout = 200e18;

    receive() external payable {}

    function initialize(
        address _owner,
        address _speedMarketsAMM,
        address _addressManager
    ) external {
        speedMarketsAMM = _speedMarketsAMM;
        addressManager = _addressManager;
    }
    
    function setMarketUserAsFreeBetsHolder(address _market, address _freeBetsHolder) external {
        marketToFreeBetsHolder[_market] = _freeBetsHolder;
    }
    
    function setDummyValues(uint _buyInAmount, address _collateral, uint _payout) external {
        dummyBuyInAmount = _buyInAmount;
        dummyCollateral = _collateral;
        dummyPayout = _payout;
    }

    function resolveMarket(address market, bytes[] calldata priceUpdateData) external payable {
        _checkAndCallFreeBetsHolder(market, false);
    }

    function resolveMarketWithOfframp(
        address market,
        bytes[] calldata priceUpdateData,
        address collateral,
        bool toEth
    ) external payable {
        _checkAndCallFreeBetsHolder(market, false);
    }

    function resolveMarketsBatch(address[] calldata markets, bytes[] calldata priceUpdateData)
        external
        payable
    {
        for (uint i = 0; i < markets.length; i++) {
            _checkAndCallFreeBetsHolder(markets[i], false);
        }
    }

    function resolveMarketsBatchOffRamp(
        address[] calldata markets,
        bytes[] calldata priceUpdateData,
        address collateral,
        bool toEth
    ) external payable {
        for (uint i = 0; i < markets.length; i++) {
            _checkAndCallFreeBetsHolder(markets[i], false);
        }
    }

    function resolveMarketManually(address _market, int64 _finalPrice) external {
        _checkAndCallFreeBetsHolder(_market, false);
    }

    function resolveMarketManuallyBatch(address[] calldata markets, int64[] calldata finalPrices) external {
        for (uint i = 0; i < markets.length; i++) {
            _checkAndCallFreeBetsHolder(markets[i], false);
        }
    }

    function resolveChainedMarket(address market, bytes[][] calldata priceUpdateData)
        external
        payable
    {
        _checkAndCallFreeBetsHolder(market, true);
    }

    function resolveChainedMarketWithOfframp(
        address market,
        bytes[][] calldata priceUpdateData,
        address collateral,
        bool toEth
    ) external payable {
        _checkAndCallFreeBetsHolder(market, true);
    }

    function resolveChainedMarketsBatch(address[] calldata markets, bytes[][][] calldata priceUpdateData)
        external
        payable
    {
        for (uint i = 0; i < markets.length; i++) {
            _checkAndCallFreeBetsHolder(markets[i], true);
        }
    }

    function resolveChainedMarketsBatchOffRamp(
        address[] calldata markets,
        bytes[][][] calldata priceUpdateData,
        address collateral,
        bool toEth
    ) external payable {
        for (uint i = 0; i < markets.length; i++) {
            _checkAndCallFreeBetsHolder(markets[i], true);
        }
    }

    function resolveChainedMarketManually(address _market, int64[] calldata _finalPrices) external {
        _checkAndCallFreeBetsHolder(_market, true);
    }

    function resolveChainedMarketManuallyBatch(address[] calldata markets, int64[][] calldata finalPrices) external {
        for (uint i = 0; i < markets.length; i++) {
            _checkAndCallFreeBetsHolder(markets[i], true);
        }
    }

    function setupMultiCollateralApproval(uint amount) external {
        // Mock implementation - do nothing
    }

    function setChainedSpeedMarketsAMM(address _chainedSpeedMarketsAMM) external {
        chainedSpeedMarketsAMM = _chainedSpeedMarketsAMM;
    }
    
    function _checkAndCallFreeBetsHolder(address market, bool) internal {
        address freeBetsHolder = marketToFreeBetsHolder[market];
        if (freeBetsHolder != address(0)) {
            IFreeBetsHolder(freeBetsHolder).confirmSpeedMarketResolved(
                market,
                dummyPayout,
                dummyBuyInAmount,
                dummyCollateral
            );
        }
    }
}