// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISportsAMMV2 {
    enum GameResult {
        Cancelled,
        Home,
        Away,
        Draw
    }

    struct GameScore {
        uint24 homeScore;
        uint24 awayScore;
    }

    function defaultCollateral() external view returns (IERC20);

    function minBuyInAmount() external view returns (uint);

    function maxTicketSize() external view returns (uint);

    function maxSupportedAmount() external view returns (uint);

    function maxSupportedOdds() external view returns (uint);

    function safeBoxFee() external view returns (uint);

    function getGameResult(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        int24 _line
    ) external view returns (GameResult);

    function isGameResolved(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        int24 _line
    ) external view returns (bool);

    function resolveTicket(
        address _ticketOwner,
        bool _hasUserWon,
        bool _cancelled,
        uint _buyInAmount,
        address _ticketCreator
    ) external;

    function exerciseTicket(address _ticket) external;
}
