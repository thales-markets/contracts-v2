// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";
import "./../AMM/Ticket.sol";

contract SportsAMMV2Data is Initializable, ProxyOwned, ProxyPausable {
    /* ========== STRUCT VARIABLES ========== */
    struct SportsAMMParameters {
        uint minBuyInAmount;
        uint maxTicketSize;
        uint maxSupportedAmount;
        uint maxSupportedOdds;
        uint safeBoxFee;
        bool paused;
    }

    struct MarketData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint maturity;
        int24 line;
        uint24 playerId;
        uint8 position;
        uint odd;
        ISportsAMMV2.CombinedPosition[] combinedPositions;
    }

    struct MarketResult {
        ISportsAMMV2ResultManager.MarketPositionStatus status;
        int24[] results;
    }

    struct TicketData {
        address id;
        MarketData[] marketsData;
        MarketResult[] marketsResult;
        address collateral;
        address ticketOwner;
        uint buyInAmount;
        uint fees;
        uint totalQuote;
        uint numOfMarkets;
        uint expiry;
        uint createdAt;
        bool resolved;
        bool paused;
        bool cancelled;
        bool isLost;
        bool isUserTheWinner;
        bool isExercisable;
        uint finalPayout;
        bool isLive;
    }

    enum ResultType {
        Unassigned,
        ExactPosition,
        OverUnder,
        CombinedPositions
    }

    /* ========== STATE VARIABLES ========== */

    ISportsAMMV2 public sportsAMM;

    ISportsAMMV2RiskManager public riskManager;

    function initialize(address _owner, ISportsAMMV2 _sportsAMM, ISportsAMMV2RiskManager _riskManager) external initializer {
        setOwner(_owner);
        sportsAMM = _sportsAMM;
        riskManager = _riskManager;
    }

    function getSportsAMMParameters() external view returns (SportsAMMParameters memory) {
        return
            SportsAMMParameters(
                riskManager.minBuyInAmount(),
                riskManager.maxTicketSize(),
                riskManager.maxSupportedAmount(),
                riskManager.maxSupportedOdds(),
                sportsAMM.safeBoxFee(),
                sportsAMM.paused()
            );
    }

    /// @notice return all ticket data for an array of tickets
    function getTicketsData(address[] calldata ticketsArray) external view returns (TicketData[] memory) {
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all active ticket data for user
    function getActiveTicketsDataPerUser(address user) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = sportsAMM.manager().getActiveTicketsPerUser(
            0,
            sportsAMM.manager().numOfActiveTicketsPerUser(user),
            user
        );
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all resolved ticket data for user
    function getResolvedTicketsDataPerUser(address user) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = sportsAMM.manager().getResolvedTicketsPerUser(
            0,
            sportsAMM.manager().numOfResolvedTicketsPerUser(user),
            user
        );
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all ticket data for game
    function getTicketsDataPerGame(bytes32 gameId) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = sportsAMM.manager().getTicketsPerGame(
            0,
            sportsAMM.manager().numOfTicketsPerGame(gameId),
            gameId
        );
        return _getTicketsData(ticketsArray);
    }

    function areMarketsResolved(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds
    ) external view returns (bool[] memory resolvedMarkets) {
        if (_gameIds.length == _typeIds.length && _typeIds.length == _playerIds.length) {
            resolvedMarkets = new bool[](_gameIds.length);
            for (uint i = 0; i < _gameIds.length; i++) {
                uint8 resultType = sportsAMM.resultManager().resultTypePerMarketType(_typeIds[i]);
                if (resultType != uint8(ResultType.CombinedPositions)) {
                    ISportsAMMV2.CombinedPosition[] memory combinedPositions = new ISportsAMMV2.CombinedPosition[](0);
                    resolvedMarkets[i] = sportsAMM.resultManager().isMarketResolved(
                        _gameIds[i],
                        _typeIds[i],
                        _playerIds[i],
                        0,
                        combinedPositions
                    );
                }
            }
        }
    }

    function getResultsForMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds
    ) external view returns (int24[][] memory resultsForMarkets) {
        if (_gameIds.length == _typeIds.length && _typeIds.length == _playerIds.length) {
            resultsForMarkets = new int24[][](_gameIds.length);
            for (uint i = 0; i < _gameIds.length; i++) {
                resultsForMarkets[i] = sportsAMM.resultManager().getResultsPerMarket(
                    _gameIds[i],
                    _typeIds[i],
                    _playerIds[i]
                );
            }
        }
    }

    function _getTicketsData(address[] memory ticketsArray) internal view returns (TicketData[] memory) {
        TicketData[] memory tickets = new TicketData[](ticketsArray.length);
        for (uint i = 0; i < ticketsArray.length; i++) {
            Ticket ticket = Ticket(ticketsArray[i]);
            MarketData[] memory marketsData = new MarketData[](ticket.numOfMarkets());
            MarketResult[] memory marketsResult = new MarketResult[](ticket.numOfMarkets());
            for (uint j = 0; j < ticket.numOfMarkets(); j++) {
                marketsData[j] = _getMarketData(ticket, j);
                marketsResult[j] = _getMarketResult(ticket, j);
            }

            tickets[i] = TicketData(
                ticketsArray[i],
                marketsData,
                marketsResult,
                address(ticket.collateral()),
                ticket.ticketOwner(),
                ticket.buyInAmount(),
                ticket.fees(),
                ticket.totalQuote(),
                ticket.numOfMarkets(),
                ticket.expiry(),
                ticket.createdAt(),
                ticket.resolved(),
                ticket.paused(),
                ticket.cancelled(),
                ticket.isTicketLost(),
                ticket.isUserTheWinner(),
                ticket.isTicketExercisable(),
                ticket.finalPayout(),
                ticket.isLive()
            );
        }
        return tickets;
    }

    function _getMarketData(Ticket ticket, uint marketIndex) internal view returns (MarketData memory) {
        (
            bytes32 gameId,
            uint16 sportId,
            uint16 typeId,
            uint maturity,
            ,
            int24 line,
            uint24 playerId,
            uint8 position,
            uint odd
        ) = ticket.markets(marketIndex);
        ISportsAMMV2.CombinedPosition[] memory combinedPositions = ticket.getCombinedPositions(marketIndex);

        return MarketData(gameId, sportId, typeId, maturity, line, playerId, position, odd, combinedPositions);
    }

    function _getMarketResult(Ticket ticket, uint marketIndex) internal view returns (MarketResult memory) {
        (bytes32 gameId, , uint16 typeId, , , int24 line, uint24 playerId, uint8 position, ) = ticket.markets(marketIndex);
        ISportsAMMV2.CombinedPosition[] memory combinedPositions = ticket.getCombinedPositions(marketIndex);

        ISportsAMMV2ResultManager.MarketPositionStatus status = sportsAMM.resultManager().getMarketPositionStatus(
            gameId,
            typeId,
            playerId,
            line,
            position,
            combinedPositions
        );

        int24[] memory results = sportsAMM.resultManager().getResultsPerMarket(gameId, typeId, playerId);

        return MarketResult(status, results);
    }

    function setSportsAMM(ISportsAMMV2 _sportsAMM) external onlyOwner {
        sportsAMM = _sportsAMM;
        emit SportAMMChanged(address(_sportsAMM));
    }

    function setRiskManager(ISportsAMMV2RiskManager _riskManager) external onlyOwner {
        riskManager = _riskManager;
        emit RiskManagerChanged(address(_riskManager));
    }

    event SportAMMChanged(address sportsAMM);
    event RiskManagerChanged(address riskManager);
}
