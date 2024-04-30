// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SportsAMMV2LiquidityPoolRound {
    /* ========== LIBRARIES ========== */
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    // the adddress of the LP contract
    address public liquidityPool;

    // the adddress of collateral that LP accepts
    IERC20 public collateral;

    // the round number
    uint public round;

    // the round start time
    uint public roundStartTime;

    // the round end time
    uint public roundEndTime;

    // initialized flag
    bool public initialized;

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the storage in the contract with the parameters
    /// @param _liquidityPool the adddress of the LP contract
    /// @param _collateral the adddress of collateral that LP accepts
    /// @param _round the round number
    /// @param _roundStartTime the round start time
    /// @param _roundEndTime the round end time
    function initialize(
        address _liquidityPool,
        IERC20 _collateral,
        uint _round,
        uint _roundStartTime,
        uint _roundEndTime
    ) external {
        require(!initialized, "Already initialized");
        initialized = true;
        liquidityPool = _liquidityPool;
        collateral = _collateral;
        round = _round;
        roundStartTime = _roundStartTime;
        roundEndTime = _roundEndTime;
        collateral.approve(_liquidityPool, type(uint256).max);
    }

    /// @notice update round times
    /// @param _roundStartTime the round start time
    /// @param _roundEndTime the round end time
    function updateRoundTimes(uint _roundStartTime, uint _roundEndTime) external onlyLiquidityPool {
        roundStartTime = _roundStartTime;
        roundEndTime = _roundEndTime;
        emit RoundTimesUpdated(_roundStartTime, _roundEndTime);
    }

    modifier onlyLiquidityPool() {
        require(msg.sender == liquidityPool, "Only LP may perform this method");
        _;
    }

    event RoundTimesUpdated(uint roundStartTime, uint roundEndTime);
}
