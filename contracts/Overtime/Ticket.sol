// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// internal
import "../utils/OwnedWithInit.sol";
import "../interfaces/ISportsAMMV2.sol";

contract Ticket is OwnedWithInit {
    uint private constant ONE = 1e18;

    struct GameData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint16 playerPropsTypeId;
        uint maturityDate;
        uint8 status;
        int24 line;
        uint16 playerId;
        uint8 position;
        uint odd;
    }

    ISportsAMMV2 public sportsAMM;
    address public ticketOwner;

    uint public buyInAmount;
    uint public totalQuote;
    uint public numOfGames;

    bool public resolved;
    bool public paused;
    bool public initialized;

    mapping(uint => GameData) public games;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        GameData[] calldata _parameters,
        uint _buyInAmount,
        uint _totalQuote,
        address _sportsAMM,
        address _ticketOwner
    ) external {
        require(!initialized, "Ticket already initialized");
        initialized = true;
        initOwner(msg.sender);
        sportsAMM = ISportsAMMV2(_sportsAMM);
        numOfGames = _parameters.length;
        for (uint i = 0; i < numOfGames; i++) {
            games[i] = _parameters[i];
        }
        buyInAmount = _buyInAmount;
        totalQuote = _totalQuote;
        ticketOwner = _ticketOwner;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    function isTicketLost() public view returns (bool) {
        bool gameWinning;
        bool gameResolved;
        for (uint i = 0; i < numOfGames; i++) {
            (gameWinning, gameResolved) = _isWinningPosition(games[i]);
            if (gameResolved && !gameWinning) {
                return true;
            }
        }
        return false;
    }

    function areAllPositionsResolved() public view returns (bool) {
        for (uint i = 0; i < numOfGames; i++) {
            if (!sportsAMM.isGameResolved(games[i].gameId, games[i].sportId, games[i].typeId, games[i].playerPropsTypeId)) {
                return false;
            }
        }
        return true;
    }

    function isUserTheWinner() external view returns (bool hasUserWon) {
        if (areAllPositionsResolved()) {
            hasUserWon = !isTicketLost();
        }
    }

    function isTicketExercisable() public view returns (bool isExercisable) {
        isExercisable = !resolved && (areAllPositionsResolved() || isTicketLost());
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    function exercise() external onlyAMM {
        require(!paused, "Market paused");
        bool isExercisable = isTicketExercisable();
        require(isExercisable, "Ticket not exercisable yet");
        uint payout = sportsAMM.defaultPaymentToken().balanceOf(address(this));
        if (isTicketLost()) {
            if (payout > 0) {
                sportsAMM.defaultPaymentToken().transfer(address(sportsAMM), payout);
            }
        } else {
            uint finalPayout = payout;
            for (uint i = 0; i < numOfGames; i++) {
                uint result = sportsAMM.gameResults(
                    games[i].gameId,
                    games[i].sportId,
                    games[i].typeId,
                    games[i].playerPropsTypeId
                );
                // TODO: add constant for Canceled
                if (result == 0) {
                    finalPayout = (finalPayout * games[i].odd) / ONE;
                }
            }
            sportsAMM.defaultPaymentToken().transfer(address(ticketOwner), finalPayout);
            sportsAMM.defaultPaymentToken().transfer(
                address(sportsAMM),
                sportsAMM.defaultPaymentToken().balanceOf(address(this))
            );
        }

        _resolve(!isTicketLost());
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _resolve(bool _hasUserWon) internal {
        resolved = true;
        sportsAMM.resolveTicket(ticketOwner, _hasUserWon);
        emit Resolved(_hasUserWon);
    }

    function _isWinningPosition(GameData memory game) internal view returns (bool isWinning, bool isResolved) {
        isResolved = sportsAMM.isGameResolved(game.gameId, game.sportId, game.typeId, game.playerPropsTypeId);
        uint result = sportsAMM.gameResults(game.gameId, game.sportId, game.typeId, game.playerPropsTypeId);
        // TODO: add constant for Canceled
        if (isResolved && (result == (game.position + 1) || result == 0)) {
            isWinning = true;
        }
    }

    /* ========== SETTERS ========== */

    function setPaused(bool _paused) external onlyAMM {
        require(paused != _paused, "State not changed");
        paused = _paused;
        emit PauseUpdated(_paused);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyAMM() {
        require(msg.sender == address(sportsAMM), "Only the AMM may perform these methods");
        _;
    }

    /* ========== EVENTS ========== */

    event Resolved(bool isUserTheWinner);
    event PauseUpdated(bool paused);
}
