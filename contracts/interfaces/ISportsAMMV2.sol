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

    struct TradeData {
        bytes32 gameId;
        uint16 sportId;
        uint16 childId;
        uint16 playerPropsId;
        uint maturity;
        uint8 status;
        int24 line;
        uint16 playerId;
        uint[] odds;
        bytes32[] merkleProof;
        uint8 position;
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

    function isGameCancelled(
        bytes32 _gameId,
        uint _sportId,
        uint _childId,
        uint _playerPropsId,
        uint _playerId,
        int _line
    ) external view returns (bool);

    function gameScores(bytes32 _gameId, uint _playerPropsId, uint _playerId) external view returns (GameScore memory);

    function resolveTicket(
        address _ticketOwner,
        bool _hasUserWon,
        bool _cancelled,
        uint _buyInAmount,
        address _ticketCreator
    ) external;

    function exerciseTicket(address _ticket) external;

    function getTicketsPerGame(uint _index, uint _pageSize, bytes32 _gameId) external view returns (address[] memory);

    function numOfTicketsPerGame(bytes32 _gameId) external view returns (uint);

    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);

    function numOfActiveTicketsPerUser(address _user) external view returns (uint);

    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);

    function numOfResolvedTicketsPerUser(address _user) external view returns (uint);
}
