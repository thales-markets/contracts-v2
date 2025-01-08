#!/bin/bash

# Function to run a script and wait
run_script() {
    echo "==================================================="
    echo "Running $1..."
    echo "==================================================="
    npx hardhat run $1 --network baseMainnet
    echo "Waiting 3 seconds before next deployment..."
    sleep 3
}

echo "Starting deployments..."
echo "==================================================="

# 1. Core Contracts (First Wave)
echo "Deploying Core Contracts - First Wave..."
run_script "scripts/deployContracts/deploySportsAMMV2Manager.js"
run_script "scripts/deployContracts/deploySportsAMMV2ResultManager.js"
run_script "scripts/deployContracts/deploySportsAMMV2RiskManager.js"

# 2. Core Contracts (Second Wave)
echo "Deploying Core Contracts - Second Wave..."
run_script "scripts/deployContracts/deploySportsAMMV2.js"
run_script "scripts/deployContracts/deploySportsAMMV2Data.js"
run_script "scripts/deployContracts/deployTicketMastercopy.js"

# 3. Liquidity Pool Infrastructure
echo "Deploying Liquidity Pool Infrastructure..."
run_script "scripts/deployContracts/deployLiquidityPool/deploySportsAMMV2LiquidityPoolData.js"
run_script "scripts/deployContracts/deployLiquidityPool/deploySportsAMMV2LiquidityPoolRoundMastercopy.js"

# 4. USDC Liquidity Pool
echo "Deploying USDC Liquidity Pool..."
run_script "scripts/deployContracts/deployLiquidityPool/deploySportsAMMV2LiquidityPool.js"
run_script "scripts/deployContracts/deployLiquidityPool/deployDefaultLiquidityProvider.js"

# 5. WETH Liquidity Pool
echo "Deploying WETH Liquidity Pool..."
run_script "scripts/deployContracts/deployETHLiquidityPool/deploySportsAMMV2LiquidityPool.js"
run_script "scripts/deployContracts/deployETHLiquidityPool/deployDefaultLiquidityProvider.js"

# 7. OVER Liquidity Pool
echo "Deploying OVER Liquidity Pool..."
run_script "scripts/deployContracts/deployOVERLiquidityPool/deploySportsAMMV2LiquidityPool.js"
run_script "scripts/deployContracts/deployOVERLiquidityPool/deployDefaultLiquidityProvider.js"

# 8. Deploy OTP
echo "Deploying OTP..."
run_script "scripts/deployUtils/deployOTP.js"

echo "==================================================="
echo "All deployments completed!"
echo "==================================================="