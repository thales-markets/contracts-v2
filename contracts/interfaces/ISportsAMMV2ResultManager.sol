// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./ISportsAMMV2.sol";

interface ISportsAMMV2ResultManager {
    enum MarketPositionStatus {
        Open,
        Cancelled,
        Winning,
        Losing
    }

    function isMarketResolved(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        ISportsAMMV2.CombinedPosition[] memory combinedPositions
    ) external view returns (bool isResolved);

    function getMarketPositionStatus(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (MarketPositionStatus status);

    function isWinningMarketPosition(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (bool isWinning);

    function isCancelledMarketPosition(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (bool isCancelled);

    function getResultsPerMarket(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId
    ) external view returns (int24[] memory results);

    function resultTypePerMarketType(uint _typeId) external view returns (uint8 marketType);

    function setResultsPerMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds,
        int24[][] memory _results
    ) external;

    function isGameCancelled(bytes32 _gameId) external view returns (bool);

    function cancelGames(bytes32[] memory _gameIds) external;

    function cancelMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds,
        int24[] memory _lines
    ) external;

    function cancelMarket(bytes32 _gameId, uint16 _typeId, uint24 _playerId, int24 _line) external;

    function cancelGame(bytes32 _gameId) external;
}
