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

    bytes32 public marketGameId;
    uint16 public marketSportId;
    uint16 public marketTypeId;
    uint public marketMaturity;
    uint8 public marketStatus;
    int24 public marketLine;
    uint24 public marketPlayerId;
    uint8 public marketPosition;
    uint public marketOdd;

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

    function markets(uint) external view returns (bytes32, uint16, uint16, uint, uint8, int24, uint24, uint8, uint) {
        return (
            marketGameId,
            marketSportId,
            marketTypeId,
            marketMaturity,
            marketStatus,
            marketLine,
            marketPlayerId,
            marketPosition,
            marketOdd
        );
    }

    function setMarketData(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint _maturity,
        uint8 _status,
        int24 _line,
        uint24 _playerId,
        uint8 _position,
        uint _odd
    ) external {
        marketGameId = _gameId;
        marketSportId = _sportId;
        marketTypeId = _typeId;
        marketMaturity = _maturity;
        marketStatus = _status;
        marketLine = _line;
        marketPlayerId = _playerId;
        marketPosition = _position;
        marketOdd = _odd;
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
