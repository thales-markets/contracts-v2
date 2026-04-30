// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Read surface of the Baccarat contract consumed by CasinoData
interface ICasinoBaccarat {
    function getBetBase(
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

    function getBetDetails(
        uint id
    )
        external
        view
        returns (
            uint8 betType,
            uint8 status,
            uint8 result,
            bool won,
            bool isPush,
            uint8[6] memory cards,
            uint8 playerTotal,
            uint8 bankerTotal
        );

    function isFreeBet(uint id) external view returns (bool);

    function getRecentBetIds(uint offset, uint limit) external view returns (uint[] memory);

    function getUserBetIds(address user, uint offset, uint limit) external view returns (uint[] memory);

    function nextBetId() external view returns (uint);
}
