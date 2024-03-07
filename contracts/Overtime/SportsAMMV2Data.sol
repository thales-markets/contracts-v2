// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../interfaces/ISportsAMMV2.sol";
import "./Ticket.sol";

contract SportsAMMV2Data is Initializable, ProxyOwned, ProxyPausable {
    ISportsAMMV2 public sportsAMM;

    struct SportsAMMParameters {
        uint minBuyInAmount;
        uint maxTicketSize;
        uint maxSupportedAmount;
        uint maxSupportedOdds;
        uint safeBoxFee;
    }

    struct GameData {
        bytes32 gameId;
        uint16 sportId;
        uint16 childId;
        uint16 playerPropsId;
        uint maturity;
        int24 line;
        uint16 playerId;
        uint8 position;
        uint odd;
        ISportsAMMV2.CombinedPosition[] combinedPositions;
    }

    struct GameStatus {
        bool isResolved;
        bool isCancelled;
        ISportsAMMV2.GameScore score;
        ISportsAMMV2.GameResult result;
    }

    struct TicketData {
        address id;
        GameData[] gamesData;
        GameStatus[] gamesStatus;
        address ticketOwner;
        address ticketCreator;
        uint buyInAmount;
        uint buyInAmountAfterFees;
        uint totalQuote;
        uint numOfGames;
        uint expiry;
        uint createdAt;
        bool resolved;
        bool paused;
        bool cancelled;
        bool isLost;
        bool isUserTheWinner;
        bool isExercisable;
    }

    function initialize(address _owner, address _sportsAMM) external initializer {
        setOwner(_owner);
        sportsAMM = ISportsAMMV2(_sportsAMM);
    }

    function getSportsAMMParameters() external view returns (SportsAMMParameters memory) {
        return
            SportsAMMParameters(
                sportsAMM.minBuyInAmount(),
                sportsAMM.maxTicketSize(),
                sportsAMM.maxSupportedAmount(),
                sportsAMM.maxSupportedOdds(),
                sportsAMM.safeBoxFee()
            );
    }

    /// @notice return all ticket data for an array of tickets
    function getTicketsData(address[] calldata ticketsArray) external view returns (TicketData[] memory) {
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all active ticket data for user
    function getActiveTicketsDataPerUser(address user) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = sportsAMM.getActiveTicketsPerUser(
            0,
            sportsAMM.numOfActiveTicketsPerUser(user),
            user
        );
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all resolved ticket data for user
    function getResolvedTicketsDataPerUser(address user) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = sportsAMM.getResolvedTicketsPerUser(
            0,
            sportsAMM.numOfResolvedTicketsPerUser(user),
            user
        );
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all ticket data for game
    function getTicketsDataPerGame(bytes32 gameId) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = sportsAMM.getTicketsPerGame(0, sportsAMM.numOfTicketsPerGame(gameId), gameId);
        return _getTicketsData(ticketsArray);
    }

    function _getTicketsData(address[] memory ticketsArray) internal view returns (TicketData[] memory) {
        TicketData[] memory tickets = new TicketData[](ticketsArray.length);
        for (uint i = 0; i < ticketsArray.length; i++) {
            Ticket ticket = Ticket(ticketsArray[i]);
            GameData[] memory gamesData = new GameData[](ticket.numOfGames());
            GameStatus[] memory gamesStatus = new GameStatus[](ticket.numOfGames());
            for (uint j = 0; j < ticket.numOfGames(); j++) {
                gamesData[j] = _getGameData(ticket, j);
                gamesStatus[j] = _getGameStatus(ticket, j);
            }

            tickets[i] = TicketData(
                ticketsArray[i],
                gamesData,
                gamesStatus,
                ticket.ticketOwner(),
                ticket.ticketCreator(),
                ticket.buyInAmount(),
                ticket.buyInAmountAfterFees(),
                ticket.totalQuote(),
                ticket.numOfGames(),
                ticket.expiry(),
                ticket.createdAt(),
                ticket.resolved(),
                ticket.paused(),
                ticket.cancelled(),
                ticket.isTicketLost(),
                ticket.isUserTheWinner(),
                ticket.isTicketExercisable()
            );
        }
        return tickets;
    }

    function _getGameData(Ticket ticket, uint gameIndex) internal view returns (GameData memory) {
        (
            bytes32 gameId,
            uint16 sportId,
            uint16 childId,
            uint16 playerPropsId,
            uint maturity,
            ,
            int24 line,
            uint16 playerId,
            uint8 position,
            uint odd
        ) = ticket.games(gameIndex);
        ISportsAMMV2.CombinedPosition[] memory combinedPositions = ticket.getCombinedPositions(gameIndex);

        return GameData(gameId, sportId, childId, playerPropsId, maturity, line, playerId, position, odd, combinedPositions);
    }

    function _getGameStatus(Ticket ticket, uint gameIndex) internal view returns (GameStatus memory) {
        (bytes32 gameId, uint16 sportId, uint16 childId, uint16 playerPropsId, , , int24 line, uint16 playerId, , ) = ticket
            .games(gameIndex);

        bool isResolved = sportsAMM.isGameResolved(gameId, sportId, childId, playerPropsId, playerId, line);

        ISportsAMMV2.GameScore memory score = sportsAMM.gameScores(gameId, playerPropsId, playerId);

        ISportsAMMV2.GameResult result = sportsAMM.getGameResult(gameId, sportId, childId, playerPropsId, playerId, line);

        bool isCancelled = sportsAMM.isGameCancelled(gameId, sportId, childId, playerPropsId, playerId, line) ||
            (isResolved && result == ISportsAMMV2.GameResult.Cancelled);

        return GameStatus(isResolved, isCancelled, score, result);
    }

    function setSportsAMM(ISportsAMMV2 _sportsAMM) external onlyOwner {
        sportsAMM = _sportsAMM;
        emit SportAMMChanged(address(_sportsAMM));
    }

    event SportAMMChanged(address sportsAMM);
}
