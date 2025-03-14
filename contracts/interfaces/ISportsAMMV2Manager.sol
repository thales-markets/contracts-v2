// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ISportsAMMV2.sol";

interface ISportsAMMV2Manager {
    enum Role {
        ROOT_SETTING,
        RISK_MANAGING,
        MARKET_RESOLVING,
        TICKET_PAUSER
    }

    function isWhitelistedAddress(address _address, Role role) external view returns (bool);

    function decimals() external view returns (uint);

    function feeToken() external view returns (address);

    function isActiveTicket(address _ticket) external view returns (bool);

    function getActiveTickets(uint _index, uint _pageSize) external view returns (address[] memory);

    function numOfActiveTickets() external view returns (uint);

    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);

    function numOfActiveTicketsPerUser(address _user) external view returns (uint);

    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);

    function numOfResolvedTicketsPerUser(address _user) external view returns (uint);

    function getTicketsPerGame(uint _index, uint _pageSize, bytes32 _gameId) external view returns (address[] memory);

    function numOfTicketsPerGame(bytes32 _gameId) external view returns (uint);

    function isKnownTicket(address _ticket) external view returns (bool);

    function sportsAMM() external view returns (address);

    function getTicketsPerMarket(
        uint _index,
        uint _pageSize,
        bytes32 _gameId,
        uint _typeId,
        uint _playerId
    ) external view returns (address[] memory);

    function numOfTicketsPerMarket(bytes32 _gameId, uint _typeId, uint _playerId) external view returns (uint);

    function addNewKnownTicket(ISportsAMMV2.TradeData[] memory _tradeData, address ticket, address user) external;

    function resolveKnownTicket(address ticket, address ticketOwner) external;

    function expireKnownTicket(address ticket, address ticketOwner) external;

    function isSystemTicket(address _ticket) external view returns (bool);

    function isSGPTicket(address _ticket) external view returns (bool);
}
