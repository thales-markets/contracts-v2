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
        uint maturity;
        uint8 status;
        int24 line;
        uint16 playerId;
        uint8 position;
        uint odd;
    }

    ISportsAMMV2 public sportsAMM;
    address public ticketOwner;
    address public ticketCreator;

    uint public buyInAmount;
    uint public buyInAmountAfterFees;
    uint public totalQuote;
    uint public numOfGames;
    uint public expiry;
    uint public createdAt;

    bool public resolved;
    bool public paused;
    bool public initialized;
    bool public cancelled;

    mapping(uint => GameData) public games;

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the ticket contract
    /// @param _gameData data with all game info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _buyInAmountAfterFees ticket buy-in amount without fees
    /// @param _totalQuote total ticket quote
    /// @param _sportsAMM address of Sports AMM contact
    /// @param _ticketOwner owner of the ticket
    /// @param _ticketCreator creator of the ticket
    /// @param _expiry ticket expiry timestamp
    function initialize(
        GameData[] calldata _gameData,
        uint _buyInAmount,
        uint _buyInAmountAfterFees,
        uint _totalQuote,
        address _sportsAMM,
        address _ticketOwner,
        address _ticketCreator,
        uint _expiry
    ) external {
        require(!initialized, "Ticket already initialized");
        initialized = true;
        initOwner(msg.sender);
        sportsAMM = ISportsAMMV2(_sportsAMM);
        numOfGames = _gameData.length;
        for (uint i = 0; i < numOfGames; i++) {
            games[i] = _gameData[i];
        }
        buyInAmount = _buyInAmount;
        buyInAmountAfterFees = _buyInAmountAfterFees;
        totalQuote = _totalQuote;
        ticketOwner = _ticketOwner;
        ticketCreator = _ticketCreator;
        expiry = _expiry;
        createdAt = block.timestamp;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice checks if the user lost the ticket
    /// @return isTicketLost true/false
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

    /// @notice checks are all positions of the ticket resolved
    /// @return areAllPositionsResolved true/false
    function areAllPositionsResolved() public view returns (bool) {
        for (uint i = 0; i < numOfGames; i++) {
            if (
                !sportsAMM.isGameResolved(
                    games[i].gameId,
                    games[i].sportId,
                    games[i].childId,
                    games[i].playerPropsId,
                    games[i].playerId,
                    games[i].line
                )
            ) {
                return false;
            }
        }
        return true;
    }

    /// @notice checks if the user won the ticket
    /// @return hasUserWon true/false
    function isUserTheWinner() external view returns (bool hasUserWon) {
        if (areAllPositionsResolved()) {
            hasUserWon = !isTicketLost();
        }
    }

    /// @notice checks if the ticket ready to be exercised
    /// @return isExercisable true/false
    function isTicketExercisable() public view returns (bool isExercisable) {
        isExercisable = !resolved && (areAllPositionsResolved() || isTicketLost());
    }

    /// @notice gets current phase of the ticket
    /// @return phase ticket phase
    function phase() public view returns (Phase) {
        return resolved ? ((expiry < block.timestamp) ? Phase.Expiry : Phase.Maturity) : Phase.Trading;
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice exercise ticket
    function exercise() external onlyAMM {
        require(!paused, "Market paused");
        bool isExercisable = isTicketExercisable();
        require(isExercisable, "Ticket not exercisable yet");

        uint payout = sportsAMM.defaultCollateral().balanceOf(address(this));
        bool isCancelled = false;

        if (isTicketLost()) {
            if (payout > 0) {
                sportsAMM.defaultCollateral().transfer(address(sportsAMM), payout);
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
            sportsAMM.defaultCollateral().transfer(address(ticketOwner), isCancelled ? buyInAmount : finalPayout);

            uint balance = sportsAMM.defaultCollateral().balanceOf(address(this));
            if (balance != 0) {
                sportsAMM.defaultCollateral().transfer(
                    address(sportsAMM),
                    sportsAMM.defaultCollateral().balanceOf(address(this))
                );
            }
        }

        _resolve(!isTicketLost(), isCancelled);
    }

    /// @notice expire ticket
    function expire(address payable beneficiary) external onlyAMM {
        require(phase() == Phase.Expiry, "Ticket expired");
        require(!resolved, "Can't expire resolved parlay.");
        emit Expired(beneficiary);
        _selfDestruct(beneficiary);
    }

    /// @notice withdraw collateral from the ticket
    function withdrawCollateral(address recipient) external onlyAMM {
        sportsAMM.defaultCollateral().transfer(recipient, sportsAMM.defaultCollateral().balanceOf(address(this)));
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _resolve(bool _hasUserWon, bool _cancelled) internal {
        resolved = true;
        cancelled = _cancelled;
        sportsAMM.resolveTicket(ticketOwner, _hasUserWon, _cancelled, buyInAmount, ticketCreator);
        emit Resolved(_hasUserWon, _cancelled);
    }

    function _isWinningPosition(GameData memory game) internal view returns (bool isWinning, bool isResolved) {
        isResolved = sportsAMM.isGameResolved(
            game.gameId,
            game.sportId,
            game.childId,
            game.playerPropsId,
            game.playerId,
            game.line
        );
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
        uint balance = sportsAMM.defaultCollateral().balanceOf(address(this));
        if (balance != 0) {
            sportsAMM.defaultCollateral().transfer(beneficiary, balance);
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

    event Resolved(bool isUserTheWinner, bool cancelled);
    event Expired(address beneficiary);
    event PauseUpdated(bool paused);
}
