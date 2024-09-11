// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IProxyBetting {
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);
    function numOfActiveTicketsPerUser(address _user) external view returns (uint);
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint);

    function confirmTicketResolved(address _resolvedTicket) external;
}
