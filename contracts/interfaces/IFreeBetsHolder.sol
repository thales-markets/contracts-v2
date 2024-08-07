// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFreeBetsHolder {
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);
    function numOfActiveTicketsPerUser(address _user) external view returns (uint);
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory);
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint);

    function confirmLiveTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount, address _collateral) external;

    function confirmTicketResolved(address _resolvedTicket) external;
}
