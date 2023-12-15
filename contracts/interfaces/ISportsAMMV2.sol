// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISportsAMMV2 {
    /* ========== VIEWS / VARIABLES ========== */

    function defaultPaymentToken() external view returns (IERC20);

    function gameResults(bytes32 _gameId, uint _sportId, uint _typeId, uint playerPropsTypeId) external view returns (uint);

    function isGameResolved(
        bytes32 _gameId,
        uint _sportId,
        uint _typeId,
        uint playerPropsTypeId
    ) external view returns (bool);

    function resolveTicket(address _account, bool _hasUserWon) external;
}
