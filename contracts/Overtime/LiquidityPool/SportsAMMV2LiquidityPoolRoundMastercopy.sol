// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Internal references
import "./SportsAMMV2LiquidityPoolRound.sol";

contract SportsAMMV2LiquidityPoolRoundMastercopy is SportsAMMV2LiquidityPoolRound {
    constructor() {
        // Freeze mastercopy on deployment so it can never be initialized with real arguments
        initialized = true;
    }
}
