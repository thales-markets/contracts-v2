// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ISpeedMarketsAMMCreator {

    enum Direction {
        Up,
        Down
    }

    struct SpeedMarketParams {
        bytes32 asset;
        uint64 strikeTime;
        uint64 delta;
        uint strikePrice;
        uint strikePriceSlippage;
        Direction direction;
        address collateral;
        uint buyinAmount;
        address referrer;
        uint skewImpact;
    }

    struct PendingSpeedMarket {
        address user;
        bytes32 asset;
        uint64 strikeTime;
        uint64 delta;
        uint strikePrice;
        uint strikePriceSlippage;
        Direction direction;
        address collateral;
        uint buyinAmount;
        address referrer;
        uint skewImpact;
        uint256 createdAt;
    }

    struct ChainedSpeedMarketParams {
        bytes32 asset;
        uint64 timeFrame;
        uint strikePrice;
        uint strikePriceSlippage;
        Direction[] directions;
        address collateral;
        uint buyinAmount;
        address referrer;
    }

    struct PendingChainedSpeedMarket {
        address user;
        bytes32 asset;
        uint64 timeFrame;
        uint strikePrice;
        uint strikePriceSlippage;
        Direction[] directions;
        address collateral;
        uint buyinAmount;
        address referrer;
        uint256 createdAt;
    }

    function pendingSpeedMarkets(uint256 _index) external view returns (PendingSpeedMarket memory);

    function pendingChainedSpeedMarkets(uint256 _index) external view returns (PendingChainedSpeedMarket memory);

    function getPendingSpeedMarketsSize() external view returns (uint256);

    function getPendingChainedSpeedMarketsSize() external view returns (uint256);
    
    function addPendingSpeedMarket(SpeedMarketParams calldata _params) external returns (bytes32);

    function addPendingChainedSpeedMarket(ChainedSpeedMarketParams calldata _params) external returns (bytes32);
    
    function getChainedAndSpeedMarketsAMMAddresses() external view returns (address chainedAMM, address speedAMM);

}
