// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISportsAMMV2 {
    struct GameScore {
        uint24 homeScore;
        uint24 awayScore;
    }

    function defaultPaymentToken() external view returns (IERC20);

    function getGameResult(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        int24 _line
    ) external view returns (uint);

    function isGameResolved(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId
    ) external view returns (bool);

    function resolveTicket(address _account, bool _hasUserWon) external;
}
