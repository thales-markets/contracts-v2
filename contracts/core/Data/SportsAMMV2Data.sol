// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";
import "../../interfaces/IFreeBetsHolder.sol";
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
        uint maxAllowedSystemCombinations;
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
        bool isSystem;
        uint8 systemBetDenominator;
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

    /**
     * @notice Retrieves the parameters used by the SportsAMM contract.
     * @dev Returns a struct containing various configurable parameters for the SportsAMM.
     * @return A `SportsAMMParameters` struct containing:
     * - `minBuyInAmount`: Minimum buy-in amount.
     * - `maxTicketSize`: Maximum size of a single ticket.
     * - `maxSupportedAmount`: Maximum amount supported by the AMM.
     * - `maxSupportedOdds`: Maximum odds supported by the AMM.
     * - `safeBoxFee`: Fee for the safe box.
     * - `paused`: Whether the SportsAMM is currently paused.
     * - `maxAllowedSystemCombinations`: Maximum allowed system combinations.
     */
    function getSportsAMMParameters() external view returns (SportsAMMParameters memory) {
        return
            SportsAMMParameters(
                riskManager.minBuyInAmount(),
                riskManager.maxTicketSize(),
                riskManager.maxSupportedAmount(),
                riskManager.maxSupportedOdds(),
                sportsAMM.safeBoxFee(),
                sportsAMM.paused(),
                riskManager.maxAllowedSystemCombinations()
            );
    }

    /**
     * @notice Retrieves data for the specified tickets.
     * @dev Fetches ticket information for a given array of ticket addresses.
     * @param ticketsArray An array of ticket addresses to retrieve data for.
     * @return An array of `TicketData` containing details for each ticket.
     */
    function getTicketsData(address[] calldata ticketsArray) external view returns (TicketData[] memory) {
        return _getTicketsData(ticketsArray);
    }

    /**
     * @notice Retrieves active ticket data for a specific user within a paginated range.
     * @dev Fetches data for active tickets, free bets, and staking proxy tickets.
     * @param user The address of the user.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return ticketsData Active tickets data.
     * @return freeBetsData Free bets data.
     * @return stakingBettingProxyData Staking proxy tickets data.
     */
    function getActiveTicketsDataPerUser(
        address user,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (
            TicketData[] memory ticketsData,
            TicketData[] memory freeBetsData,
            TicketData[] memory stakingBettingProxyData
        )
    {
        address[] memory freeBetsArray = sportsAMM.freeBetsHolder().getActiveTicketsPerUser(_startIndex, _pageSize, user);
        address[] memory ticketsArray = sportsAMM.manager().getActiveTicketsPerUser(_startIndex, _pageSize, user);
        ticketsData = _getTicketsData(ticketsArray);
        freeBetsData = _getTicketsData(freeBetsArray);
    }

    /**
     * @notice Retrieves resolved ticket data for a specific user within a paginated range.
     * @dev Fetches data for resolved tickets, free bets, and staking proxy tickets.
     * @param user The address of the user.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return ticketsData Resolved tickets data.
     * @return freeBetsData Free bets data.
     * @return stakingBettingProxyData Staking proxy tickets data.
     */
    function getResolvedTicketsDataPerUser(
        address user,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (
            TicketData[] memory ticketsData,
            TicketData[] memory freeBetsData,
            TicketData[] memory stakingBettingProxyData
        )
    {
        address[] memory freeBetsArray = sportsAMM.freeBetsHolder().getResolvedTicketsPerUser(_startIndex, _pageSize, user);
        address[] memory ticketsArray = sportsAMM.manager().getResolvedTicketsPerUser(_startIndex, _pageSize, user);
        ticketsData = _getTicketsData(ticketsArray);
        freeBetsData = _getTicketsData(freeBetsArray);
    }

    /**
     * @notice Retrieves ticket data for a specific game within a paginated range.
     * @dev Fetches ticket information for tickets associated with the given game ID.
     * @param gameId The ID of the game to retrieve tickets for.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return An array of `TicketData` containing details for the tickets of the specified game.
     */
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

    /**
     * @notice Retrieves active game IDs and their associated tickets within a paginated range.
     * @dev Filters only active game IDs and retrieves tickets for each game ID.
     * @param _gameIds An array of game IDs to filter and process.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return activeGameIds An array of active game IDs.
     * @return numOfTicketsPerGameId An array of ticket counts for each active game ID.
     * @return ticketsPerGameId A 2D array of ticket addresses for each active game ID.
     */
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

    /**
     * @notice Retrieves all active game IDs, type IDs, player IDs, and lines for the specified game IDs within a paginated range.
     * @dev Processes active game IDs and tickets, retrieving unique type IDs, player IDs, and market lines.
     * @param _gameIds An array of game IDs to filter and process.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of game IDs to process in the current page.
     * @return finalTicketsInfo An array of TicketMarketInfo containing active market details for the specified game IDs.
     */
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

    /**
     * @notice Checks if specified markets are resolved.
     * @dev Determines the resolution status of markets by querying the result manager.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _typeIds An array of type IDs associated with the markets.
     * @param _playerIds An array of player IDs associated with the markets.
     * @param _lines An array of market lines for the specified markets.
     * @return resolvedMarkets An array of booleans indicating whether each market is resolved.
     */
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

    /**
     * @notice Retrieves the results for the specified markets.
     * @dev Queries the result manager for results based on game, type, and player IDs.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _typeIds An array of type IDs associated with the markets.
     * @param _playerIds An array of player IDs associated with the markets.
     * @return resultsForMarkets A 2D array containing market results for each specified market.
     */
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

    /**
     * @notice Retrieves the amount spent on specified games.
     * @dev Queries the risk manager for the spent amounts for each game ID.
     * @param _gameIds An array of game IDs to calculate the spent amounts for.
     * @return spentAmounts An array of spent amounts corresponding to each game ID.
     */
    function getSpentOnGames(bytes32[] calldata _gameIds) external view returns (uint[] memory spentAmounts) {
        spentAmounts = new uint[](_gameIds.length);
        for (uint i = 0; i < _gameIds.length; i++) {
            spentAmounts[i] = riskManager.spentOnGame(_gameIds[i]);
        }
    }

    /**
     * @notice Retrieves the risk amounts for specific market positions.
     * @dev This function queries the risk manager to get the risk per market type and position.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _typeIds An array of type IDs representing the types of the markets.
     * @param _playerIds An array of player IDs associated with the markets.
     * @param _positions An array of positions in the markets.
     * @return riskAmounts An array of risk amounts corresponding to the provided market details.
     */
    function getRiskOnMarkets(
        bytes32[] calldata _gameIds,
        uint[] calldata _typeIds,
        uint[] calldata _playerIds,
        uint[] calldata _positions
    ) external view returns (int[] memory riskAmounts) {
        riskAmounts = new int[](_gameIds.length);
        for (uint i = 0; i < _gameIds.length; i++) {
            riskAmounts[i] = riskManager.riskPerMarketTypeAndPosition(
                _gameIds[i],
                _typeIds[i],
                _playerIds[i],
                _positions[i]
            );
        }
    }

    /**
     * @notice Calculates the caps for specific markets based on their details.
     * @dev This function queries the risk manager to determine the cap to be used for each market.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _sportIds An array of sport IDs associated with the markets.
     * @param _typeIds An array of type IDs representing the types of the markets.
     * @param _maturities An array of maturities (timestamps) for the markets.
     * @return caps An array of cap values corresponding to the provided market details.
     */
    function getCapsPerMarkets(
        bytes32[] calldata _gameIds,
        uint16[] calldata _sportIds,
        uint16[] calldata _typeIds,
        uint[] calldata _maturities
    ) external view returns (uint[] memory caps) {
        caps = new uint[](_gameIds.length);
        for (uint i = 0; i < _gameIds.length; i++) {
            caps[i] = riskManager.calculateCapToBeUsed(_gameIds[i], _sportIds[i], _typeIds[i], 0, 0, _maturities[i], false);
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
            bool isSystem = sportsAMM.manager().isSystemTicket(address(ticket));

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
                ticket.isLive(),
                isSystem,
                isSystem ? ticket.systemBetDenominator() : 0
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
