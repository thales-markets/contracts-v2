// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// internal
import "../utils/OwnedWithInit.sol";
import "../interfaces/ISportsAMMV2.sol";

contract Ticket is OwnedWithInit {
    uint private constant ONE = 1e18;

    enum Phase {
        Trading,
        Maturity,
        Expiry
    }

    struct GameData {
        bytes32 gameId;
        uint16 sportId;
        uint16 childId;
        uint16 playerPropsId;
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
    uint public buyInAmountAfterFees;
    uint public totalQuote;
    uint public numOfGames;
    uint public expiry;

    bool public resolved;
    bool public paused;
    bool public initialized;
    bool public cancelled;

    mapping(uint => GameData) public games;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        GameData[] calldata _parameters,
        uint _buyInAmount,
        uint _buyInAmountAfterFees,
        uint _totalQuote,
        address _sportsAMM,
        address _ticketOwner,
        uint _expiry
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
        buyInAmountAfterFees = _buyInAmountAfterFees;
        totalQuote = _totalQuote;
        ticketOwner = _ticketOwner;
        expiry = _expiry;
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
            if (
                !sportsAMM.isGameResolved(
                    games[i].gameId,
                    games[i].sportId,
                    games[i].childId,
                    games[i].playerPropsId,
                    games[i].playerId
                )
            ) {
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

    function phase() public view returns (Phase) {
        if (resolved) {
            if (resolved && expiry < block.timestamp) {
                return Phase.Expiry;
            } else {
                return Phase.Maturity;
            }
        } else {
            return Phase.Trading;
        }
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    function exercise() external onlyAMM {
        require(!paused, "Market paused");
        bool isExercisable = isTicketExercisable();
        require(isExercisable, "Ticket not exercisable yet");

        uint payout = sportsAMM.defaultPaymentToken().balanceOf(address(this));
        bool isCancelled = false;

        if (isTicketLost()) {
            if (payout > 0) {
                sportsAMM.defaultPaymentToken().transfer(address(sportsAMM), payout);
            }
        } else {
            uint finalPayout = payout;
            isCancelled = true;
            for (uint i = 0; i < numOfGames; i++) {
                ISportsAMMV2.GameResult result = sportsAMM.getGameResult(
                    games[i].gameId,
                    games[i].sportId,
                    games[i].childId,
                    games[i].playerPropsId,
                    games[i].playerId,
                    games[i].line
                );
                if (result == ISportsAMMV2.GameResult.Cancelled) {
                    finalPayout = (finalPayout * games[i].odd) / ONE;
                } else {
                    isCancelled = false;
                }
            }
            sportsAMM.defaultPaymentToken().transfer(address(ticketOwner), isCancelled ? buyInAmount : finalPayout);

            uint balance = sportsAMM.defaultPaymentToken().balanceOf(address(this));
            if (balance != 0) {
                sportsAMM.defaultPaymentToken().transfer(
                    address(sportsAMM),
                    sportsAMM.defaultPaymentToken().balanceOf(address(this))
                );
            }
        }

        _resolve(!isTicketLost(), isCancelled);
    }

    function expire(address payable beneficiary) external onlyAMM {
        require(phase() == Phase.Expiry, "Ticket expired");
        require(!resolved, "Can't expire resolved parlay.");
        emit Expired(beneficiary);
        _selfDestruct(beneficiary);
    }

    function withdrawCollateral(address recipient) external onlyAMM {
        sportsAMM.defaultPaymentToken().transfer(recipient, sportsAMM.defaultPaymentToken().balanceOf(address(this)));
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _resolve(bool _hasUserWon, bool _cancelled) internal {
        resolved = true;
        cancelled = _cancelled;
        sportsAMM.resolveTicket(ticketOwner, _hasUserWon);
        emit Resolved(_hasUserWon);
    }

    function _isWinningPosition(GameData memory game) internal view returns (bool isWinning, bool isResolved) {
        isResolved = sportsAMM.isGameResolved(game.gameId, game.sportId, game.childId, game.playerPropsId, game.playerId);
        ISportsAMMV2.GameResult result = sportsAMM.getGameResult(
            game.gameId,
            game.sportId,
            game.childId,
            game.playerPropsId,
            game.playerId,
            game.line
        );
        if (isResolved && (uint(result) == (game.position + 1) || result == ISportsAMMV2.GameResult.Cancelled)) {
            isWinning = true;
        }
    }

    function _selfDestruct(address payable beneficiary) internal {
        uint balance = sportsAMM.defaultPaymentToken().balanceOf(address(this));
        if (balance != 0) {
            sportsAMM.defaultPaymentToken().transfer(beneficiary, balance);
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
    event Expired(address beneficiary);
    event PauseUpdated(bool paused);
}
