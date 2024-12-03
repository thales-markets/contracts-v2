// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "./../LiquidityPool/SportsAMMV2LiquidityPool.sol";

contract SportsAMMV2LiquidityPoolData is Initializable, ProxyOwned, ProxyPausable {
    struct LiquidityPoolData {
        address collateral;
        bool started;
        uint maxAllowedDeposit;
        uint round;
        uint totalDeposited;
        uint minDepositAmount;
        uint maxAllowedUsers;
        uint usersCurrentlyInPool;
        bool canCloseCurrentRound;
        bool paused;
        uint roundLength;
        uint allocationCurrentRound;
        uint lifetimePnl;
        uint roundEndTime;
    }

    struct UserLiquidityPoolData {
        uint balanceCurrentRound;
        uint balanceNextRound;
        bool withdrawalRequested;
        uint withdrawalShare;
    }

    struct RoundTicketsData {
        uint totalTickets;
        uint numOfClosedTickets;
        uint numOfPendingTickets;
        address[] pendingTickets;
    }

    function initialize(address _owner) external initializer {
        setOwner(_owner);
    }

    /// @notice getLiquidityPoolData returns liquidity pool data
    /// @param liquidityPool SportsAMMV2LiquidityPool
    /// @return LiquidityPoolData
    function getLiquidityPoolData(SportsAMMV2LiquidityPool liquidityPool) external view returns (LiquidityPoolData memory) {
        uint round = liquidityPool.round();

        return
            LiquidityPoolData(
                address(liquidityPool.collateral()),
                liquidityPool.started(),
                liquidityPool.maxAllowedDeposit(),
                round,
                liquidityPool.totalDeposited(),
                liquidityPool.minDepositAmount(),
                liquidityPool.maxAllowedUsers(),
                liquidityPool.usersCurrentlyInPool(),
                liquidityPool.canCloseCurrentRound(),
                liquidityPool.paused(),
                liquidityPool.roundLength(),
                liquidityPool.allocationPerRound(round),
                liquidityPool.cumulativeProfitAndLoss(round > 0 ? round - 1 : 0),
                liquidityPool.getRoundEndTime(round)
            );
    }

    /// @notice getUserLiquidityPoolData returns user liquidity pool data
    /// @param liquidityPool SportsAMMV2LiquidityPool
    /// @param user address of the user
    /// @return UserLiquidityPoolData
    function getUserLiquidityPoolData(
        SportsAMMV2LiquidityPool liquidityPool,
        address user
    ) external view returns (UserLiquidityPoolData memory) {
        uint round = liquidityPool.round();

        return
            UserLiquidityPoolData(
                liquidityPool.balancesPerRound(round, user),
                liquidityPool.balancesPerRound(round + 1, user),
                liquidityPool.withdrawalRequested(user),
                liquidityPool.withdrawalShare(user)
            );
    }

    /// @notice getCurrentRoundTicketsData returns current round ticket data
    /// @param liquidityPool SportsAMMV2LiquidityPool
    /// @return RoundTicketsData
    function getCurrentRoundTicketsData(
        SportsAMMV2LiquidityPool liquidityPool
    ) external view returns (RoundTicketsData memory) {
        uint round = liquidityPool.round();
        uint numberOfTradingTickets = liquidityPool.getNumberOfTradingTicketsPerRound(round);
        address[] memory tradingTickets = new address[](numberOfTradingTickets);
        address ticket;
        uint counter;
        for (uint i = 0; i < numberOfTradingTickets; i++) {
            ticket = liquidityPool.tradingTicketsPerRound(round, i);
            if (!liquidityPool.ticketAlreadyExercisedInRound(round, ticket)) {
                tradingTickets[i] = ticket;
                ++counter;
            }
        }
        address[] memory pendingTickets = new address[](counter);
        uint j;
        for (uint i = 0; i < numberOfTradingTickets; i++) {
            if (tradingTickets[i] != address(0) && j < counter) {
                pendingTickets[j] = tradingTickets[i];
                ++j;
            }
        }
        return
            RoundTicketsData(
                numberOfTradingTickets,
                (numberOfTradingTickets - pendingTickets.length),
                pendingTickets.length,
                pendingTickets
            );
    }

    /// @notice getCurrentRoundTickets returns current round tickets
    /// @param liquidityPool SportsAMMV2LiquidityPool
    /// @return tickets
    function getCurrentRoundTickets(
        SportsAMMV2LiquidityPool liquidityPool
    ) external view returns (address[] memory tickets) {
        uint round = liquidityPool.round();
        return _getRoundTickets(liquidityPool, round);
    }

    /// @notice getRoundTickets returns round tickets
    /// @param liquidityPool SportsAMMV2LiquidityPool
    /// @param round round to get tickets for
    /// @return tickets
    function getRoundTickets(
        SportsAMMV2LiquidityPool liquidityPool,
        uint round
    ) external view returns (address[] memory tickets) {
        return _getRoundTickets(liquidityPool, round);
    }

    function _getRoundTickets(
        SportsAMMV2LiquidityPool liquidityPool,
        uint round
    ) internal view returns (address[] memory tickets) {
        uint numberOfTradingTickets = liquidityPool.getNumberOfTradingTicketsPerRound(round);
        tickets = new address[](numberOfTradingTickets);
        for (uint i = 0; i < numberOfTradingTickets; i++) {
            tickets[i] = liquidityPool.tradingTicketsPerRound(round, i);
        }
    }
}
