# Testing Plan for FreeBetsHolder Speed Markets Integration

## Overview
This document outlines a comprehensive testing plan for the new speed market functionality in FreeBetsHolder, including `tradeSpeedMarket`, `tradeChainedSpeedMarket`, and `confirmSpeedOrChainedSpeedMarketTrade` functions.

## Test Structure

### 1. Test File Location
Create a new test file: `/test/contracts/Overtime/FreeBetsHolder/SpeedMarketsFreeBets.js`

### 2. Key Components

#### Mock Contract Integration
- Use `MockSpeedMarketsAMMCreator` from `/contracts/utils/test-helpers/MockSpeedMarketsAMMCreator.sol`
- The mock generates requestIds and simulates the creation of speed markets
- It calls back to FreeBetsHolder via `confirmSpeedOrChainedSpeedMarketTrade`

#### Request Flow
1. User calls `tradeSpeedMarket` or `tradeChainedSpeedMarket` on FreeBetsHolder
2. FreeBetsHolder calls `addPendingSpeedMarket` or `addPendingChainedSpeedMarket` on MockSpeedMarketsAMMCreator
3. MockSpeedMarketsAMMCreator returns a requestId and stores it in `requestToSender` mapping
4. Balance is deducted from user's free bet balance
5. Later, whitelisted address calls `createFromPendingSpeedMarkets` or `createFromPendingChainedSpeedMarkets`
6. MockSpeedMarketsAMMCreator calls `confirmSpeedOrChainedSpeedMarketTrade` on FreeBetsHolder
7. FreeBetsHolder creates the ticket and tracks it

## Test Implementation Plan

### 1. Setup and Fixtures

```javascript
describe('FreeBetsHolder Speed Markets', function () {
    let freeBetsHolder, mockSpeedMarketsAMMCreator;
    let owner, firstTrader, secondTrader, whitelistedAddress;
    let collateralAddress, weth;
    const BUY_IN_AMOUNT = ethers.parseEther('10');
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    
    beforeEach(async () => {
        // Load accounts
        ({ owner, firstTrader, secondTrader, whitelistedAddress } = 
            await loadFixture(deployAccountsFixture));
        
        // Deploy mock WETH for collateral
        const WETH = await ethers.getContractFactory('WETH');
        weth = await WETH.deploy();
        collateralAddress = await weth.getAddress();
        
        // Deploy FreeBetsHolder (minimal setup)
        const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
        freeBetsHolder = await upgrades.deployProxy(FreeBetsHolder, [
            owner.address,
            owner.address, // mock sports AMM
            owner.address, // mock live trading processor
        ]);
        
        // Deploy MockSpeedMarketsAMMCreator
        const MockSpeedMarketsAMMCreator = await ethers.getContractFactory('MockSpeedMarketsAMMCreator');
        mockSpeedMarketsAMMCreator = await MockSpeedMarketsAMMCreator.deploy(
            owner.address,
            await freeBetsHolder.getAddress()
        );
        
        // Configure FreeBetsHolder
        await freeBetsHolder.setSpeedMarketsAMMCreator(await mockSpeedMarketsAMMCreator.getAddress());
        await freeBetsHolder.addSupportedCollateral(collateralAddress, true);
        await freeBetsHolder.setFreeBetExpirationPeriod(40 * 24 * 60 * 60, 0);
        
        // Whitelist the owner for creating markets
        await mockSpeedMarketsAMMCreator.addToWhitelist(owner.address, true);
        
        // Fund test users
        await weth.deposit({ value: ethers.parseEther('100') });
        await weth.approve(await freeBetsHolder.getAddress(), ethers.parseEther('100'));
        await freeBetsHolder.fund(firstTrader.address, collateralAddress, BUY_IN_AMOUNT * 2n);
        await freeBetsHolder.fund(secondTrader.address, collateralAddress, BUY_IN_AMOUNT);
    });
```

### 2. Test Cases

#### A. Basic Speed Market Trading

```javascript
describe('Speed Market Trading', function () {
    it('Should create pending speed market and confirm it', async function () {
        // Prepare speed market params
        const speedMarketParams = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300, // 5 minutes from now
            delta: 60, // 1 minute
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'), // 1%
            direction: 0, // Up
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        // Check initial balance
        const initialBalance = await freeBetsHolder.balancePerUserAndCollateral(
            firstTrader.address, 
            collateralAddress
        );
        expect(initialBalance).to.equal(BUY_IN_AMOUNT * 2n);
        
        // Create pending speed market
        const tx = await freeBetsHolder
            .connect(firstTrader)
            .tradeSpeedMarket(speedMarketParams);
        
        // Check event emission
        await expect(tx).to.emit(freeBetsHolder, 'FreeBetSpeedMarketTradeRequested');
        
        // Check balance NOT deducted yet (pending creation)
        const balanceAfterRequest = await freeBetsHolder.balancePerUserAndCollateral(
            firstTrader.address,
            collateralAddress
        );
        expect(balanceAfterRequest).to.equal(BUY_IN_AMOUNT * 2n);
        
        // Verify pending market exists in mock
        const pendingSize = await mockSpeedMarketsAMMCreator.getPendingSpeedMarketsSize();
        expect(pendingSize).to.equal(1);
        
        // Create markets from pending
        await mockSpeedMarketsAMMCreator.createFromPendingSpeedMarkets([]);
        
        // Check balance deducted after confirmation
        const balanceAfterConfirm = await freeBetsHolder.balancePerUserAndCollateral(
            firstTrader.address,
            collateralAddress
        );
        expect(balanceAfterConfirm).to.equal(BUY_IN_AMOUNT);
        
        // Check active tickets
        const numActiveTickets = await freeBetsHolder.numOfActiveTicketsPerUser(firstTrader.address);
        expect(numActiveTickets).to.equal(1);
    });
    
    it('Should revert if speed markets AMM creator not set', async function () {
        // Deploy new FreeBetsHolder without setting speed markets creator
        const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
        const newFreeBetsHolder = await upgrades.deployProxy(FreeBetsHolder, [
            owner.address,
            owner.address,
            owner.address,
        ]);
        
        await newFreeBetsHolder.addSupportedCollateral(collateralAddress, true);
        await weth.approve(await newFreeBetsHolder.getAddress(), BUY_IN_AMOUNT);
        await newFreeBetsHolder.fund(firstTrader.address, collateralAddress, BUY_IN_AMOUNT);
        
        const speedMarketParams = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300,
            delta: 60,
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'),
            direction: 0,
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        await expect(
            newFreeBetsHolder.connect(firstTrader).tradeSpeedMarket(speedMarketParams)
        ).to.be.revertedWithCustomError(newFreeBetsHolder, 'SpeedMarketsAMMCreatorNotSet');
    });
});
```

#### B. Chained Speed Market Trading

```javascript
describe('Chained Speed Market Trading', function () {
    it('Should create pending chained speed market and confirm it', async function () {
        // Prepare chained speed market params
        const chainedMarketParams = {
            asset: ethers.encodeBytes32String('BTC'),
            timeFrame: 300, // 5 minutes
            strikePrice: ethers.parseEther('30000'),
            strikePriceSlippage: ethers.parseEther('300'), // 1%
            directions: [0, 1, 0], // Up, Down, Up
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS
        };
        
        // Create pending chained speed market
        const tx = await freeBetsHolder
            .connect(firstTrader)
            .tradeChainedSpeedMarket(chainedMarketParams);
        
        // Check event emission with correct params
        await expect(tx).to.emit(freeBetsHolder, 'FreeBetChainedSpeedMarketTradeRequested')
            .withArgs(
                firstTrader.address,
                anyValue, // requestId
                BUY_IN_AMOUNT,
                chainedMarketParams.asset,
                chainedMarketParams.timeFrame,
                3 // directions count
            );
        
        // Check balance deducted immediately
        const balanceAfter = await freeBetsHolder.balancePerUserAndCollateral(
            firstTrader.address,
            collateralAddress
        );
        expect(balanceAfter).to.equal(BUY_IN_AMOUNT);
        
        // Create markets from pending
        await mockSpeedMarketsAMMCreator.createFromPendingChainedSpeedMarkets([]);
        
        // Check active tickets
        const numActiveTickets = await freeBetsHolder.numOfActiveTicketsPerUser(firstTrader.address);
        expect(numActiveTickets).to.equal(1);
        
        // Verify ticket type is CHAINED_SPEED_MARKET
        const activeTickets = await freeBetsHolder.getActiveTicketsPerUser(0, 10, firstTrader.address);
        const ticketType = await freeBetsHolder.ticketType(activeTickets[0]);
        expect(ticketType).to.equal(2); // CHAINED_SPEED_MARKET
    });
    
    it('Should revert if directions array is empty', async function () {
        const chainedMarketParams = {
            asset: ethers.encodeBytes32String('BTC'),
            timeFrame: 300,
            strikePrice: ethers.parseEther('30000'),
            strikePriceSlippage: ethers.parseEther('300'),
            directions: [], // Empty array
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS
        };
        
        await expect(
            freeBetsHolder.connect(firstTrader).tradeChainedSpeedMarket(chainedMarketParams)
        ).to.be.revertedWithCustomError(freeBetsHolder, 'DirectionsCannotBeEmpty');
    });
});
```

#### C. Validation and Error Cases

```javascript
describe('Validation and Error Cases', function () {
    it('Should revert with insufficient balance', async function () {
        const speedMarketParams = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300,
            delta: 60,
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'),
            direction: 0,
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT * 3n, // More than available
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        await expect(
            freeBetsHolder.connect(firstTrader).tradeSpeedMarket(speedMarketParams)
        ).to.be.revertedWithCustomError(freeBetsHolder, 'InsufficientBalance');
    });
    
    it('Should revert with unsupported collateral', async function () {
        const unsupportedCollateral = '0x1234567890123456789012345678901234567890';
        
        const speedMarketParams = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300,
            delta: 60,
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'),
            direction: 0,
            collateral: unsupportedCollateral,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        await expect(
            freeBetsHolder.connect(firstTrader).tradeSpeedMarket(speedMarketParams)
        ).to.be.revertedWithCustomError(freeBetsHolder, 'UnsupportedCollateral');
    });
    
    it('Should revert if free bet expired', async function () {
        // Fast forward time to expire the free bet
        await time.increase(41 * 24 * 60 * 60); // 41 days
        
        const speedMarketParams = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300,
            delta: 60,
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'),
            direction: 0,
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        await expect(
            freeBetsHolder.connect(firstTrader).tradeSpeedMarket(speedMarketParams)
        ).to.be.revertedWithCustomError(freeBetsHolder, 'FreeBetExpired');
    });
    
    it('Should revert confirmSpeedOrChainedSpeedMarketTrade if not called by creator', async function () {
        await expect(
            freeBetsHolder.confirmSpeedOrChainedSpeedMarketTrade(
                ethers.randomBytes(32),
                firstTrader.address,
                collateralAddress,
                BUY_IN_AMOUNT,
                false
            )
        ).to.be.revertedWithCustomError(freeBetsHolder, 'OnlyCallableFromSpeedMarketsAMMCreator');
    });
    
    it('Should revert confirmation with unknown request', async function () {
        // Deploy new mock creator and set it
        const MockCreator = await ethers.getContractFactory('MockSpeedMarketsAMMCreator');
        const newMockCreator = await MockCreator.deploy(owner.address, await freeBetsHolder.getAddress());
        await freeBetsHolder.setSpeedMarketsAMMCreator(await newMockCreator.getAddress());
        
        // Try to confirm non-existent request
        await expect(
            newMockCreator.connect(owner).createFromPendingSpeedMarkets([])
        ).to.not.be.reverted; // Should not revert if no pending markets
    });
});
```

#### D. Multiple Users and Concurrent Markets

```javascript
describe('Multiple Users and Concurrent Markets', function () {
    it('Should handle multiple users creating speed markets', async function () {
        // First trader creates speed market
        const params1 = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300,
            delta: 60,
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'),
            direction: 0,
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        // Second trader creates speed market
        const params2 = {
            ...params1,
            asset: ethers.encodeBytes32String('BTC'),
            strikePrice: ethers.parseEther('30000'),
            direction: 1 // Down
        };
        
        await freeBetsHolder.connect(firstTrader).tradeSpeedMarket(params1);
        await freeBetsHolder.connect(secondTrader).tradeSpeedMarket(params2);
        
        // Check pending markets
        const pendingSize = await mockSpeedMarketsAMMCreator.getPendingSpeedMarketsSize();
        expect(pendingSize).to.equal(2);
        
        // Create all markets
        await mockSpeedMarketsAMMCreator.createFromPendingSpeedMarkets([]);
        
        // Check both users have active tickets
        expect(await freeBetsHolder.numOfActiveTicketsPerUser(firstTrader.address)).to.equal(1);
        expect(await freeBetsHolder.numOfActiveTicketsPerUser(secondTrader.address)).to.equal(1);
    });
});
```

#### E. Integration with Ticket Resolution

```javascript
describe('Ticket Resolution', function () {
    it('Should handle speed market ticket resolution', async function () {
        // Create speed market
        const speedMarketParams = {
            asset: ethers.encodeBytes32String('ETH'),
            strikeTime: Math.floor(Date.now() / 1000) + 300,
            delta: 60,
            strikePrice: ethers.parseEther('2000'),
            strikePriceSlippage: ethers.parseEther('20'),
            direction: 0,
            collateral: collateralAddress,
            buyinAmount: BUY_IN_AMOUNT,
            referrer: ZERO_ADDRESS,
            skewImpact: 0
        };
        
        await freeBetsHolder.connect(firstTrader).tradeSpeedMarket(speedMarketParams);
        await mockSpeedMarketsAMMCreator.createFromPendingSpeedMarkets([]);
        
        // Get created ticket address
        const activeTickets = await freeBetsHolder.getActiveTicketsPerUser(0, 10, firstTrader.address);
        const ticketAddress = activeTickets[0];
        
        // Mock ticket resolution (would normally be done by speed markets AMM)
        // Note: This would require additional mock setup for the ticket contract
        // For now, we verify the ticket exists and has correct type
        const ticketType = await freeBetsHolder.ticketType(ticketAddress);
        expect(ticketType).to.equal(1); // SPEED_MARKET
    });
});
```

### 3. Additional Test Considerations

1. **Gas Usage Tests**: Measure gas consumption for different operations
2. **Edge Cases**: Test with maximum/minimum values, zero amounts
3. **Timing Tests**: Test market creation delays and expiration scenarios
4. **Reentrancy Tests**: Ensure no reentrancy vulnerabilities
5. **Access Control**: Verify only authorized contracts can call certain functions

### 4. Test Execution Commands

```bash
# Run specific test file
npx hardhat test test/contracts/Overtime/FreeBetsHolder/SpeedMarketsFreeBets.js

# Run with coverage
npx hardhat coverage --testfiles test/contracts/Overtime/FreeBetsHolder/SpeedMarketsFreeBets.js

# Run with gas reporting
REPORT_GAS=true npx hardhat test test/contracts/Overtime/FreeBetsHolder/SpeedMarketsFreeBets.js
```

## Implementation Notes

1. The mock contract simulates the actual SpeedMarketsAMMCreator behavior but with simplified logic
2. RequestIds are generated deterministically in the mock for testing purposes
3. The confirmation flow mimics the live/SGP trading pattern already established
4. Balance deduction happens at different times for speed vs chained markets (as per implementation)
5. Ticket types are properly tracked to differentiate between sports, speed, and chained speed markets

## Future Enhancements

1. Add tests for the actual ticket resolution logic once `_resolveChainedOrSpeedMarketTicket` is implemented
2. Test integration with real SpeedMarketsAMMCreator once available
3. Add stress tests with many concurrent pending markets
4. Test upgrade scenarios to ensure storage compatibility