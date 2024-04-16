// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFreeBetsHolder {
    function confirmLiveTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount, address _collateral) external;
}
