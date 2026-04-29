// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Read surface of the Roulette contract consumed by CasinoData. The Pick struct ABI
/// matches Roulette.Pick; field types are widened to uint8 since the picks payload is not used
interface ICasinoRoulette {
    struct Pick {
        uint8 betType;
        uint8 selection;
        bool won;
        uint amount;
        uint reservedProfit;
        uint payout;
    }

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

    function getBetDetails(uint id) external view returns (Pick[] memory picks, uint8 status, uint8 result, bool won);

    function isFreeBet(uint id) external view returns (bool);

    function getRecentBetIds(uint offset, uint limit) external view returns (uint[] memory);

    function getUserBetIds(address user, uint offset, uint limit) external view returns (uint[] memory);

    function nextBetId() external view returns (uint);
}
