// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IFreeBetsHolder} from "../../interfaces/IFreeBetsHolder.sol";

/// @title Mock speed/chained markets creator for testing freeBetsHolder interactions
contract MockSpeedMarketsAMMCreatorV2 {
    uint private constant ONE = 1e18;

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
        bytes32 requestId; // Store requestId
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
        bytes32 requestId; // Store requestId
    }

    uint64 public maxCreationDelay;
    uint256 private requestCounter;

    PendingSpeedMarket[] public pendingSpeedMarkets;
    PendingChainedSpeedMarket[] public pendingChainedSpeedMarkets;

    address public freeBetsHolder;

    mapping(address => bool) public whitelistedAddresses;
    mapping(bytes32 => address) public requestToSender;

    address public owner;

    constructor(address _owner, address _freeBetsHolder) {
        owner = _owner;
        freeBetsHolder = _freeBetsHolder;
        maxCreationDelay = 300; // default 5 minutes
    }

    /// @notice add new speed market to pending - returns dummy requestId
    /// @param _params parameters for adding pending speed market
    function addPendingSpeedMarket(SpeedMarketParams calldata _params) external returns (bytes32 requestId) {
        return _addPendingSpeedMarket(_params);
    }

    function _addPendingSpeedMarket(SpeedMarketParams calldata _params) internal returns (bytes32 requestId) {
        // Generate dummy requestId
        requestCounter++;
        requestId = keccak256(abi.encodePacked("MOCK_REQUEST_", requestCounter, block.timestamp));
        requestToSender[requestId] = msg.sender;
        
        PendingSpeedMarket memory pendingSpeedMarket = PendingSpeedMarket(
            msg.sender,
            _params.asset,
            _params.strikeTime,
            _params.delta,
            _params.strikePrice,
            _params.strikePriceSlippage,
            _params.direction,
            _params.collateral,
            _params.buyinAmount,
            _params.referrer,
            _params.skewImpact,
            block.timestamp,
            requestId // Store the requestId
        );

        pendingSpeedMarkets.push(pendingSpeedMarket);

        emit AddSpeedMarket(pendingSpeedMarket);
    }

    /// @notice create all speed markets from pending and call freeBetsHolder
    /// @param _priceUpdateData pyth priceUpdateData (not used in mock)
    function createFromPendingSpeedMarkets(bytes[] calldata _priceUpdateData) external payable isAddressWhitelisted {
        if (pendingSpeedMarkets.length == 0) {
            return;
        }

        uint8 createdSize;
        address mockSpeedMarketAddress = address(
            uint160(uint256(keccak256(abi.encodePacked("MOCK_SPEED_MARKET", block.timestamp))))
        );

        // process all pending speed markets
        for (uint8 i = 0; i < pendingSpeedMarkets.length; i++) {
            PendingSpeedMarket memory pendingSpeedMarket = pendingSpeedMarkets[i];

            if ((pendingSpeedMarket.createdAt + maxCreationDelay) <= block.timestamp) {
                // too late for processing
                continue;
            }

            // Mock successful creation
            if (pendingSpeedMarket.user == freeBetsHolder) {
                // Use the stored requestId
                IFreeBetsHolder(freeBetsHolder).confirmSpeedOrChainedSpeedMarketTrade(
                    pendingSpeedMarket.requestId,
                    mockSpeedMarketAddress,
                    pendingSpeedMarket.collateral,
                    pendingSpeedMarket.buyinAmount,
                    false
                );
            }
            createdSize++;
        }

        uint pendingSize = pendingSpeedMarkets.length;
        delete pendingSpeedMarkets;

        emit CreateSpeedMarkets(pendingSize, createdSize);
    }

    /// @notice create speed market (mock implementation)
    /// @param _speedMarketParams parameters for creating speed market
    /// @param _priceUpdateData pyth priceUpdateData (not used in mock)
    function createSpeedMarket(
        SpeedMarketParams calldata _speedMarketParams,
        bytes[] calldata _priceUpdateData
    ) external payable isAddressWhitelisted {
        // Mock implementation - just emit event
        emit MockSpeedMarketCreated(msg.sender, _speedMarketParams.asset, _speedMarketParams.buyinAmount);
    }

    //////////////////chained/////////////////

    /// @notice add new chained speed market to pending - returns dummy requestId
    /// @param _params parameters for adding pending chained speed market
    function addPendingChainedSpeedMarket(ChainedSpeedMarketParams calldata _params) external returns (bytes32 requestId) {
        return _addPendingChainedSpeedMarket(_params);
    }

    function _addPendingChainedSpeedMarket(ChainedSpeedMarketParams calldata _params) internal returns (bytes32 requestId) {
        // Generate dummy requestId
        requestCounter++;
        requestId = keccak256(abi.encodePacked("MOCK_CHAINED_REQUEST_", requestCounter, block.timestamp));
        requestToSender[requestId] = msg.sender;
        
        PendingChainedSpeedMarket memory pendingChainedSpeedMarket = PendingChainedSpeedMarket(
            msg.sender,
            _params.asset,
            _params.timeFrame,
            _params.strikePrice,
            _params.strikePriceSlippage,
            _params.directions,
            _params.collateral,
            _params.buyinAmount,
            _params.referrer,
            block.timestamp,
            requestId // Store the requestId
        );

        pendingChainedSpeedMarkets.push(pendingChainedSpeedMarket);

        emit AddChainedSpeedMarket(pendingChainedSpeedMarket);
    }

    /// @notice create all chained speed markets from pending and call freeBetsHolder
    /// @param _priceUpdateData pyth priceUpdateData (not used in mock)
    function createFromPendingChainedSpeedMarkets(bytes[] calldata _priceUpdateData) external payable isAddressWhitelisted {
        if (pendingChainedSpeedMarkets.length == 0) {
            return;
        }

        uint8 createdSize;
        address mockChainedSpeedMarketAddress = address(
            uint160(uint256(keccak256(abi.encodePacked("MOCK_CHAINED_SPEED_MARKET", block.timestamp))))
        );

        // process all pending chained speed markets
        for (uint8 i = 0; i < pendingChainedSpeedMarkets.length; i++) {
            PendingChainedSpeedMarket memory pendingChainedSpeedMarket = pendingChainedSpeedMarkets[i];

            if ((pendingChainedSpeedMarket.createdAt + maxCreationDelay) <= block.timestamp) {
                // too late for processing
                continue;
            }

            // Mock successful creation
            if (pendingChainedSpeedMarket.user == freeBetsHolder) {
                // Use the stored requestId
                IFreeBetsHolder(freeBetsHolder).confirmSpeedOrChainedSpeedMarketTrade(
                    pendingChainedSpeedMarket.requestId,
                    mockChainedSpeedMarketAddress,
                    pendingChainedSpeedMarket.collateral,
                    pendingChainedSpeedMarket.buyinAmount,
                    true
                );
            }
            createdSize++;
        }

        uint pendingSize = pendingChainedSpeedMarkets.length;
        delete pendingChainedSpeedMarkets;

        emit CreateSpeedMarkets(pendingSize, createdSize);
    }

    /// @notice create chained speed market (mock implementation)
    /// @param _chainedMarketParams parameters for creating chained speed market
    /// @param _priceUpdateData pyth priceUpdateData (not used in mock)
    function createChainedSpeedMarket(
        ChainedSpeedMarketParams calldata _chainedMarketParams,
        bytes[] calldata _priceUpdateData
    ) external payable isAddressWhitelisted {
        // Mock implementation - just emit event
        emit MockChainedSpeedMarketCreated(msg.sender, _chainedMarketParams.asset, _chainedMarketParams.buyinAmount);
    }

    ////////////////////////////////////setters/////////////////////////////////////

    function getPendingSpeedMarketsSize() external view returns (uint256) {
        return pendingSpeedMarkets.length;
    }

    function getPendingChainedSpeedMarketsSize() external view returns (uint256) {
        return pendingChainedSpeedMarkets.length;
    }

    function addToWhitelist(address _whitelistAddress, bool _flag) external onlyOwner {
        whitelistedAddresses[_whitelistAddress] = _flag;
        emit AddedIntoWhitelist(_whitelistAddress, _flag);
    }

    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    function setMaxCreationDelay(uint64 _maxCreationDelay) external onlyOwner {
        maxCreationDelay = _maxCreationDelay;
        emit SetMaxCreationDelay(_maxCreationDelay);
    }

    /* ========== MODIFIERS ========== */

    modifier isAddressWhitelisted() {
        require(whitelistedAddresses[msg.sender], "Whitelist: not whitelisted");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    /* ========== EVENTS ========== */

    event SetMaxCreationDelay(uint64 _maxCreationDelay);
    event AddedIntoWhitelist(address _whitelistAddress, bool _flag);
    event SetFreeBetsHolder(address _freeBetsHolder);
    event AddSpeedMarket(PendingSpeedMarket _pendingSpeedMarket);
    event AddChainedSpeedMarket(PendingChainedSpeedMarket _pendingChainedSpeedMarket);
    event CreateSpeedMarkets(uint256 _pendingSize, uint8 _createdSize);
    event MockSpeedMarketCreated(address user, bytes32 asset, uint256 buyinAmount);
    event MockChainedSpeedMarketCreated(address user, bytes32 asset, uint256 buyinAmount);
}