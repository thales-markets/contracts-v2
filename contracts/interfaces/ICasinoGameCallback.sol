// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoGameCallback
/// @author Overtime
/// @notice Callback surface every game registered with `CasinoCoreV2` must implement.
/// Core dispatches VRF fulfillments to the originating game through this interface
interface ICasinoGameCallback {
    /// @notice Called by `CasinoCoreV2` once Chainlink VRF returns. Implementations must gate
    /// on `msg.sender == address(core)` to prevent spoofed fulfillments
    /// @param requestId Chainlink VRF request id
    /// @param randomWords Random words returned by VRF
    function onVrfFulfilled(uint256 requestId, uint256[] calldata randomWords) external;
}
