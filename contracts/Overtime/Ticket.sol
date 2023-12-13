// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// internal
import "../utils/OwnedWithInit.sol";
import "./SportsAMMV2.sol";

contract Ticket is OwnedWithInit {
    struct GameData {
        bytes32 gameId;
        uint sportId;
        uint typeId;
        uint playerPropsTypeId;
        uint maturityDate;
        uint status;
        uint line;
        uint playerId;
        uint position;
        uint odd;
    }

    SportsAMMV2 public sportsAMM;
    address public ticketOwner;

    uint public buyInAmount;
    uint public payout;
    uint public totalQuote;
    uint public numOfGames;

    bool public resolved;
    bool public paused;
    bool public parlayAlreadyLost;
    bool public initialized;

    mapping(uint => GameData) public games;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        GameData[] calldata _parameters,
        uint _buyInAmount,
        uint _payout,
        uint _totalQuote,
        address _sportsAMM,
        address _ticketOwner
    ) external {
        require(!initialized, "Ticket already initialized");
        initialized = true;
        initOwner(msg.sender);
        sportsAMM = SportsAMMV2(_sportsAMM);
        numOfGames = _parameters.length;
        for (uint i = 0; i < numOfGames; i++) {
            games[i] = _parameters[i];
        }
        buyInAmount = _buyInAmount;
        payout = _payout;
        totalQuote = _totalQuote;
        ticketOwner = _ticketOwner;
    }

    function setPaused(bool _paused) external onlyAMM {
        require(paused != _paused, "State not changed");
        paused = _paused;
        emit PauseUpdated(_paused);
    }

    modifier onlyAMM() {
        require(msg.sender == address(sportsAMM), "Only the AMM may perform these methods");
        _;
    }

    event Resolved(bool isUserTheWinner);
    event PauseUpdated(bool _paused);
}
