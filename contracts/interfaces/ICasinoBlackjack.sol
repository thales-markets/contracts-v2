// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Read surface of the Blackjack contract consumed by CasinoData
interface ICasinoBlackjack {
    function getHandBase(
        uint id
    ) external view returns (address user, address collateral, uint amount, uint payout, uint, uint, uint, uint);

    function getHandDetails(
        uint id
    ) external view returns (uint8 status, uint8 result, bool isDoubledDown, uint8 playerCardCount, uint8 dealerCardCount);

    function getHandCards(uint id) external view returns (uint8[] memory playerCards, uint8[] memory dealerCards);

    function isSplit(uint id) external view returns (bool);

    function getSplitDetails(
        uint id
    )
        external
        view
        returns (
            uint amount2,
            uint payout2,
            uint8 player2CardCount,
            uint8 activeHand,
            bool isAceSplit,
            bool isDoubled2,
            uint8 result2,
            uint8[] memory player2Cards
        );

    function lastRequestAt(uint id) external view returns (uint);

    function isFreeBet(uint id) external view returns (bool);

    function getRecentHandIds(uint offset, uint limit) external view returns (uint[] memory);

    function getUserHandIds(address user, uint offset, uint limit) external view returns (uint[] memory);

    function nextHandId() external view returns (uint);
}
