// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Read surface of the Slots contract consumed by CasinoData
interface ICasinoSlots {
    function getSpinBase(
        uint id
    )
        external
        view
        returns (
            address user,
            address collateral,
            uint amount,
            uint payout,
            uint requestId,
            uint placedAt,
            uint resolvedAt,
            uint reservedProfit
        );

    function getSpinDetails(uint id) external view returns (uint8 status, uint8[3] memory reels, bool won);

    function isFreeBet(uint id) external view returns (bool);

    function getRecentSpinIds(uint offset, uint limit) external view returns (uint[] memory);

    function getUserSpinIds(address user, uint offset, uint limit) external view returns (uint[] memory);

    function nextSpinId() external view returns (uint);
}
