// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICasinoFreeBetsHolder {
    /// @notice Called by whitelisted casino contracts to consume a user's free bet
    /// @dev Validates balance, expiry, and caller whitelist. Transfers tokens to caller.
    /// @param user The user whose free bet balance to deduct
    /// @param collateral The collateral token
    /// @param amount The amount to deduct and transfer
    function useFreeBet(address user, address collateral, uint amount) external;
}
