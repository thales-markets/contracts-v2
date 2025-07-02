# FreeBets Speed Markets Integration Plan

## Overview
Add functionality to FreeBetsHolder contract to allow users to create pending SpeedMarkets and ChainedSpeedMarkets using their free bet balance.

## Analysis

### Current FreeBetsHolder Functionality
- Manages free bet balances for users across different collaterals
- Supports sports betting through `trade()` and `tradeSystemBet()`
- Supports live trading through `tradeLive()` and `confirmLiveTrade()`
- Supports SGP trading through `tradeSGP()` and `confirmSGPTrade()`
- Tracks ticket ownership and resolution
- Has `TicketType` enum with SPORTS, SPEED_MARKET, and CHAINED_MARKET

### ISpeedMarketsAMMCreator Interface
- Provides `addPendingSpeedMarket()` and `addPendingChainedSpeedMarket()` functions
- Uses `SpeedMarketParams` and `ChainedSpeedMarketParams` structs
- Manages pending markets that are created later with price updates

## Implementation Completed

### 1. State Variable
- Already has `speedMarketsAMMCreator` variable (line 64)

### 2. Added Two New Functions

#### Function 1: `tradeSpeedMarket()`
```solidity
function tradeSpeedMarket(
    ISpeedMarketsAMMCreator.SpeedMarketParams calldata _params
) external
```
- Uses struct parameter to avoid stack too deep issues
- Validates user has sufficient free bet balance using `canTrade` modifier
- Deducts the buyinAmount from user's balance
- Calls `speedMarketsAMMCreator.addPendingSpeedMarket()` with the parameters
- Emits `FreeBetSpeedMarketTradeRequested` event

#### Function 2: `tradeChainedSpeedMarket()`
```solidity
function tradeChainedSpeedMarket(
    ISpeedMarketsAMMCreator.ChainedSpeedMarketParams calldata _params
) external
```
- Uses struct parameter to avoid stack too deep issues
- Validates user has sufficient free bet balance using `canTrade` modifier
- Validates that directions array is not empty
- Deducts the buyinAmount from user's balance
- Calls `speedMarketsAMMCreator.addPendingChainedSpeedMarket()` with the parameters
- Emits `FreeBetChainedSpeedMarketTradeRequested` event

### 3. Added Setter Function
```solidity
function setSpeedMarketsAMMCreator(address _speedMarketsAMMCreator) external onlyOwner
```
- Sets the Speed Markets AMM Creator contract address
- Validates address is not zero
- Emits `SetSpeedMarketsAMMCreator` event

### 4. Added Events
- `FreeBetSpeedMarketTradeRequested(address user, uint buyInAmount, bytes32 asset, uint64 strikeTime, ISpeedMarketsAMMCreator.Direction direction)`
- `FreeBetChainedSpeedMarketTradeRequested(address user, uint buyInAmount, bytes32 asset, uint64 timeFrame, uint directionsCount)`
- `SetSpeedMarketsAMMCreator(address speedMarketsAMMCreator)`

### 5. Implementation Notes
- Both functions use the existing `canTrade` modifier for validation (checks collateral support, balance, and expiration)
- Functions accept struct parameters directly to avoid stack too deep compilation errors
- No ticket creation occurs in these functions - pending markets are created later by the SpeedMarketsAMMCreator
- Unlike live/SGP trading, no confirmation callback mechanism is implemented (may need to be added if speed markets creation follows a similar pattern)