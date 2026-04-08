// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LegacyTicketMock {
    IERC20 public collateral;
    address public ticketOwner;
    uint public expectedFinalPayout;
    uint public buyInAmount;
    bool public isSystem;
    bool public isSGP;
    bool public paused;
    bool public resolved;
    bool public cancelled;
    bool public isMarkedAsLost;

    bool private winner;

    constructor(address _ticketOwner, IERC20 _collateral, uint _expectedFinalPayout, bool _winner) {
        ticketOwner = _ticketOwner;
        collateral = _collateral;
        expectedFinalPayout = _expectedFinalPayout;
        winner = _winner;
    }

    function isUserTheWinner() external view returns (bool) {
        return winner;
    }

    function numOfMarkets() external pure returns (uint) {
        return 1;
    }

    function setPaused(bool _paused) external {
        paused = _paused;
    }

    function expire(address _beneficiary) external {
        resolved = true;
        emit Expired(_beneficiary);
    }

    function markAsLost() external returns (uint) {
        resolved = true;
        isMarkedAsLost = true;
        return 0;
    }

    event Expired(address beneficiary);
}
