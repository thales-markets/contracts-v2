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

    struct TicketMarketInfo {
        bytes32 gameId;
        uint16 typeId;
        uint24 playerId;
        int24 line;
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
    function getActiveTicketsDataPerUser(
        address user,
        uint _startIndex,
        uint _pageSize
    ) external view returns (TicketData[] memory) {
        uint numOfActiveTicketsPerUser = sportsAMM.manager().numOfActiveTicketsPerUser(user);
        _pageSize = _pageSize > numOfActiveTicketsPerUser ? numOfActiveTicketsPerUser : _pageSize;
        address[] memory ticketsArray = sportsAMM.manager().getActiveTicketsPerUser(_startIndex, _pageSize, user);
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all resolved ticket data for user
    function getResolvedTicketsDataPerUser(
        address user,
        uint _startIndex,
        uint _pageSize
    ) external view returns (TicketData[] memory) {
        uint numOfResolvedTickets = sportsAMM.manager().numOfResolvedTicketsPerUser(user);
        _pageSize = _pageSize > numOfResolvedTickets ? numOfResolvedTickets : _pageSize;
        address[] memory ticketsArray = sportsAMM.manager().getResolvedTicketsPerUser(_startIndex, _pageSize, user);
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all ticket data for game
    function getTicketsDataPerGame(
        bytes32 gameId,
        uint _startIndex,
        uint _pageSize
    ) external view returns (TicketData[] memory) {
        uint numOfTicketsPerGame = sportsAMM.manager().numOfTicketsPerGame(gameId);
        _pageSize = _pageSize > numOfTicketsPerGame ? numOfTicketsPerGame : _pageSize;
        address[] memory ticketsArray = sportsAMM.manager().getTicketsPerGame(_startIndex, _pageSize, gameId);
        return _getTicketsData(ticketsArray);
    }

    function getOnlyActiveGameIdsAndTicketsOf(
        bytes32[] memory _gameIds,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (bytes32[] memory activeGameIds, uint[] memory numOfTicketsPerGameId, address[][] memory ticketsPerGameId)
    {
        (activeGameIds, numOfTicketsPerGameId, ticketsPerGameId) = _getOnlyActiveGameIdsAndTicketsOf(
            _gameIds,
            _startIndex,
            _pageSize
        );
    }

    function getAllActiveGameIdsTypeIdsPlayerIdsLinesForGameIds(
        bytes32[] memory _gameIds,
        uint _startIndex,
        uint _pageSize
    ) external view returns (TicketMarketInfo[] memory finalTicketsInfo) {
        bytes32[] memory activeGameIds;
        uint[] memory numOfTicketsPerGameId;
        address[][] memory ticketsPerGameId;
        (activeGameIds, numOfTicketsPerGameId, ticketsPerGameId) = _getOnlyActiveGameIdsAndTicketsOf(
            _gameIds,
            _startIndex,
            _pageSize
        );
        // Get number of matches
        uint matchCounter;
        for (uint i = 0; i < activeGameIds.length; i++) {
            for (uint j = 0; j < numOfTicketsPerGameId[i]; j++) {
                matchCounter += Ticket(ticketsPerGameId[i][j]).numOfMarkets();
            }
        }
        TicketMarketInfo[] memory ticketsMarkets = new TicketMarketInfo[](matchCounter);
        matchCounter = 0;
        MarketData memory marketData;
        for (uint i = 0; i < activeGameIds.length; i++) {
            for (uint j = 0; j < numOfTicketsPerGameId[i]; j++) {
                Ticket ticket = Ticket(ticketsPerGameId[i][j]);
                for (uint t = 0; t < ticket.numOfMarkets(); t++) {
                    marketData = _getMarketData(ticket, t);
                    ticketsMarkets[matchCounter].gameId = marketData.gameId;
                    ticketsMarkets[matchCounter].typeId = marketData.typeId;
                    ticketsMarkets[matchCounter].playerId = marketData.playerId;
                    ticketsMarkets[matchCounter].line = marketData.line;
                    matchCounter++;
                }
            }
        }
        (matchCounter, numOfTicketsPerGameId) = _getUniqueTypeIdsPlayerIds(ticketsMarkets);
        finalTicketsInfo = new TicketMarketInfo[](matchCounter);
        matchCounter = 0;
        for (uint i = 0; i < ticketsMarkets.length; i++) {
            if (numOfTicketsPerGameId[i] == 1) {
                finalTicketsInfo[matchCounter] = ticketsMarkets[i];
                ++matchCounter;
            }
        }
    }

    function areMarketsResolved(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds,
        int24[] memory _lines
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
                        _lines[i],
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

    function _getOnlyActiveGameIdsAndTicketsOf(
        bytes32[] memory _gameIds,
        uint _startIndex,
        uint _pageSize
    )
        internal
        view
        returns (bytes32[] memory activeGameIds, uint[] memory numOfTicketsPerGameId, address[][] memory ticketsPerGameId)
    {
        _pageSize = _pageSize > _gameIds.length ? _gameIds.length : _pageSize;
        uint[] memory ticketsPerGame = new uint[](_pageSize);
        uint counter;
        for (uint i = _startIndex; i < _pageSize; i++) {
            uint numOfTicketsPerGame = sportsAMM.manager().numOfTicketsPerGame(_gameIds[i]);
            if (numOfTicketsPerGame > 0) {
                counter++;
                ticketsPerGame[i] = numOfTicketsPerGame;
            }
        }
        activeGameIds = new bytes32[](counter);
        numOfTicketsPerGameId = new uint[](counter);
        ticketsPerGameId = new address[][](counter);
        counter = 0;
        for (uint i = 0; i < _gameIds.length; i++) {
            if (ticketsPerGame[i] > 0) {
                activeGameIds[counter] = _gameIds[i];
                numOfTicketsPerGameId[counter] = ticketsPerGame[i];
                ticketsPerGameId[counter] = sportsAMM.manager().getTicketsPerGame(0, ticketsPerGame[i], _gameIds[i]);
                counter++;
            }
        }
    }

    function _getUniqueTypeIdsPlayerIds(
        TicketMarketInfo[] memory ticketsMarkets
    ) internal pure returns (uint numOfUniqueMatches, uint[] memory uniqueIndexes) {
        bytes32[] memory uniqueHashes = new bytes32[](ticketsMarkets.length);
        uniqueIndexes = new uint[](ticketsMarkets.length);
        bytes32 currentHash;
        bool isUnique;
        for (uint i = 0; i < ticketsMarkets.length; i++) {
            currentHash = keccak256(abi.encode(ticketsMarkets[i]));
            isUnique = true;
            for (uint j = 0; j < numOfUniqueMatches; j++) {
                if (currentHash == uniqueHashes[j]) {
                    isUnique = false;
                    break;
                }
            }
            if (isUnique) {
                uniqueHashes[numOfUniqueMatches] = currentHash;
                uniqueIndexes[i] = 1;
                numOfUniqueMatches++;
            }
        }
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
