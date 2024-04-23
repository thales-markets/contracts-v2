// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../utils/libraries/AddressSetLib.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../interfaces/ISportsAMMV2.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2ResultManager.sol";
import "./Ticket.sol";

contract SportsAMMV2Data is Initializable, ProxyOwned, ProxyPausable {
    using AddressSetLib for AddressSetLib.AddressSet;

    /* ========== STRUCT VARIABLES ========== */
    struct SportsAMMParameters {
        uint minBuyInAmount;
        uint maxTicketSize;
        uint maxSupportedAmount;
        uint maxSupportedOdds;
        uint safeBoxFee;
    }

    struct MarketData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint maturity;
        int24 line;
        uint16 playerId;
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
    }

    /* ========== STATE VARIABLES ========== */

    ISportsAMMV2 public sportsAMM;

    ISportsAMMV2RiskManager public riskManager;

    // stores active tickets
    AddressSetLib.AddressSet internal knownTickets;

    // stores active tickets per user
    mapping(address => AddressSetLib.AddressSet) internal activeTicketsPerUser;

    // stores resolved tickets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedTicketsPerUser;

    // stores tickets per game
    mapping(bytes32 => AddressSetLib.AddressSet) internal ticketsPerGame;

    function initialize(address _owner, ISportsAMMV2RiskManager _riskManager) external initializer {
        setOwner(_owner);
        riskManager = _riskManager;
    }

    function saveTicketData(
        ISportsAMMV2.TradeData[] memory _tradeData,
        address ticket,
        address user
    ) external onlySportAMMV2 {
        knownTickets.add(ticket);
        activeTicketsPerUser[user].add(ticket);

        for (uint i = 0; i < _tradeData.length; i++) {
            ticketsPerGame[_tradeData[i].gameId].add(ticket);
        }
    }

    function resolveTicketData(address _ticket, address _ticketOwner) external onlySportAMMV2 {
        knownTickets.remove(_ticket);
        activeTicketsPerUser[_ticketOwner].remove(_ticket);

        resolvedTicketsPerUser[_ticketOwner].add(_ticket);
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    function onlyKnownTickets(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    /// @notice is provided ticket active
    /// @param _ticket ticket address
    /// @return isActiveTicket true/false
    function isActiveTicket(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    /// @notice gets batch of active tickets
    /// @param _index start index
    /// @param _pageSize batch size
    /// @return activeTickets
    function getActiveTickets(uint _index, uint _pageSize) external view returns (address[] memory) {
        return knownTickets.getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets
    /// @return numOfActiveTickets
    function numOfActiveTickets() external view returns (uint) {
        return knownTickets.elements.length;
    }

    /// @notice gets batch of active tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active tickets for
    /// @return activeTickets
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return activeTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets per user
    /// @param _user to get number of active tickets for
    /// @return numOfActiveTickets
    function numOfActiveTicketsPerUser(address _user) external view returns (uint) {
        return activeTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of resolved tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved tickets for
    /// @return resolvedTickets
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return resolvedTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of resolved tickets per user
    /// @param _user to get number of resolved tickets for
    /// @return numOfResolvedTickets
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint) {
        return resolvedTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of tickets per game
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _gameId to get tickets for
    /// @return resolvedTickets
    function getTicketsPerGame(uint _index, uint _pageSize, bytes32 _gameId) external view returns (address[] memory) {
        return ticketsPerGame[_gameId].getPage(_index, _pageSize);
    }

    /// @notice gets number of tickets per game
    /// @param _gameId to get number of tickets for
    /// @return numOfTickets
    function numOfTicketsPerGame(bytes32 _gameId) external view returns (uint) {
        return ticketsPerGame[_gameId].elements.length;
    }

    function getSportsAMMParameters() external view returns (SportsAMMParameters memory) {
        return
            SportsAMMParameters(
                riskManager.minBuyInAmount(),
                riskManager.maxTicketSize(),
                riskManager.maxSupportedAmount(),
                riskManager.maxSupportedOdds(),
                sportsAMM.safeBoxFee()
            );
    }

    /// @notice return all ticket data for an array of tickets
    function getTicketsData(address[] calldata ticketsArray) external view returns (TicketData[] memory) {
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all active ticket data for user
    function getActiveTicketsDataPerUser(address _user) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = activeTicketsPerUser[_user].getPage(0, activeTicketsPerUser[_user].elements.length);
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all resolved ticket data for user
    function getResolvedTicketsDataPerUser(address _user) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = resolvedTicketsPerUser[_user].getPage(
            0,
            resolvedTicketsPerUser[_user].elements.length
        );
        return _getTicketsData(ticketsArray);
    }

    /// @notice return all ticket data for game
    function getTicketsDataPerGame(bytes32 _gameId) external view returns (TicketData[] memory) {
        address[] memory ticketsArray = ticketsPerGame[_gameId].getPage(0, ticketsPerGame[_gameId].elements.length);
        return _getTicketsData(ticketsArray);
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
                ticket.isTicketExercisable()
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
            uint16 playerId,
            uint8 position,
            uint odd
        ) = ticket.markets(marketIndex);
        ISportsAMMV2.CombinedPosition[] memory combinedPositions = ticket.getCombinedPositions(marketIndex);

        return MarketData(gameId, sportId, typeId, maturity, line, playerId, position, odd, combinedPositions);
    }

    function _getMarketResult(Ticket ticket, uint marketIndex) internal view returns (MarketResult memory) {
        (bytes32 gameId, , uint16 typeId, , , int24 line, uint16 playerId, uint8 position, ) = ticket.markets(marketIndex);
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

    /* ========== SETTERS ========== */
    function setSportsAMM(ISportsAMMV2 _sportsAMM) external onlyOwner {
        sportsAMM = _sportsAMM;
        emit SportAMMChanged(address(_sportsAMM));
    }

    function setRiskManager(ISportsAMMV2RiskManager _riskManager) external onlyOwner {
        riskManager = _riskManager;
        emit RiskManagerChanged(address(_riskManager));
    }

    modifier onlySportAMMV2() {
        require(msg.sender == address(sportsAMM), "Invalid sportsAMM");
        _;
    }

    event SportAMMChanged(address sportsAMM);
    event RiskManagerChanged(address riskManager);
}
