// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// internal
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2.sol";

contract Ticket {
    using SafeERC20 for IERC20;
    uint private constant ONE = 1e18;

    enum Phase {
        Trading,
        Maturity,
        Expiry
    }

    struct MarketData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint maturity;
        uint8 status;
        int24 line;
        uint24 playerId;
        uint8 position;
        uint odd;
        ISportsAMMV2.CombinedPosition[] combinedPositions;
    }

    struct TicketInit {
        MarketData[] _markets;
        uint _buyInAmount;
        uint _fees;
        uint _totalQuote;
        address _sportsAMM;
        address _ticketOwner;
        IERC20 _collateral;
        uint _expiry;
        bool _isLive;
    }

    ISportsAMMV2 public sportsAMM;
    address public ticketOwner;
    IERC20 public collateral;

    uint public buyInAmount;
    uint public fees;
    uint public totalQuote;
    uint public numOfMarkets;
    uint public expiry;
    uint public createdAt;

    bool public resolved;
    bool public paused;
    bool public initialized;
    bool public cancelled;

    bool public isLive;

    mapping(uint => MarketData) public markets;

    uint public finalPayout;

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the ticket contract
    /// @param params all parameters for Init
    function initialize(TicketInit calldata params) external {
        require(!initialized, "Ticket already initialized");
        initialized = true;
        sportsAMM = ISportsAMMV2(params._sportsAMM);
        numOfMarkets = params._markets.length;
        for (uint i = 0; i < numOfMarkets; i++) {
            markets[i] = params._markets[i];
        }
        buyInAmount = params._buyInAmount;
        fees = params._fees;
        totalQuote = params._totalQuote;
        ticketOwner = params._ticketOwner;
        collateral = params._collateral;
        expiry = params._expiry;
        isLive = params._isLive;
        createdAt = block.timestamp;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice checks if the user lost the ticket
    /// @return isTicketLost true/false
    function isTicketLost() public view returns (bool) {
        for (uint i = 0; i < numOfMarkets; i++) {
            bool isMarketResolved = sportsAMM.resultManager().isMarketResolved(
                markets[i].gameId,
                markets[i].typeId,
                markets[i].playerId,
                markets[i].line,
                markets[i].combinedPositions
            );
            bool isWinningMarketPosition = sportsAMM.resultManager().isWinningMarketPosition(
                markets[i].gameId,
                markets[i].typeId,
                markets[i].playerId,
                markets[i].line,
                markets[i].position,
                markets[i].combinedPositions
            );
            if (isMarketResolved && !isWinningMarketPosition) {
                return true;
            }
        }
        return false;
    }

    /// @notice checks are all markets of the ticket resolved
    /// @return areAllMarketsResolved true/false
    function areAllMarketsResolved() public view returns (bool) {
        for (uint i = 0; i < numOfMarkets; i++) {
            if (
                !sportsAMM.resultManager().isMarketResolved(
                    markets[i].gameId,
                    markets[i].typeId,
                    markets[i].playerId,
                    markets[i].line,
                    markets[i].combinedPositions
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
        hasUserWon = _isUserTheWinner();
    }

    /// @notice checks if the ticket ready to be exercised
    /// @return isExercisable true/false
    function isTicketExercisable() public view returns (bool isExercisable) {
        isExercisable = !resolved && (areAllMarketsResolved() || isTicketLost());
    }

    /// @notice gets current phase of the ticket
    /// @return phase ticket phase
    function phase() public view returns (Phase) {
        return
            isTicketExercisable() || resolved ? ((expiry < block.timestamp) ? Phase.Expiry : Phase.Maturity) : Phase.Trading;
    }

    /// @notice gets combined positions of the game
    /// @return combinedPositions game combined positions
    function getCombinedPositions(
        uint _marketIndex
    ) public view returns (ISportsAMMV2.CombinedPosition[] memory combinedPositions) {
        return markets[_marketIndex].combinedPositions;
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice exercise ticket
    function exercise(address _exerciseCollateral) external onlyAMM returns (uint) {
        require(!paused, "Market paused");
        bool isExercisable = isTicketExercisable();
        require(isExercisable, "Ticket not exercisable yet");

        uint payoutWithFees = collateral.balanceOf(address(this));
        uint payout = payoutWithFees - fees;
        bool isCancelled = false;

        if (_isUserTheWinner()) {
            finalPayout = payout;
            isCancelled = true;
            for (uint i = 0; i < numOfMarkets; i++) {
                bool isCancelledMarketPosition = sportsAMM.resultManager().isCancelledMarketPosition(
                    markets[i].gameId,
                    markets[i].typeId,
                    markets[i].playerId,
                    markets[i].line,
                    markets[i].position,
                    markets[i].combinedPositions
                );
                if (isCancelledMarketPosition) {
                    finalPayout = (finalPayout * markets[i].odd) / ONE;
                } else {
                    isCancelled = false;
                }
            }
            if (isCancelled) {
                finalPayout = buyInAmount;
            }
            collateral.safeTransfer(
                _exerciseCollateral == address(0) || _exerciseCollateral == address(collateral)
                    ? address(ticketOwner)
                    : address(sportsAMM),
                finalPayout
            );
        }

        // if user is lost or if the user payout was less than anticipated due to cancelled games, send the remainder to AMM
        uint balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            collateral.safeTransfer(address(sportsAMM), balance);
        }

        _resolve(!isTicketLost(), isCancelled);
        return finalPayout;
    }

    /// @notice expire ticket
    function expire(address _beneficiary) external onlyAMM {
        require(phase() == Phase.Expiry, "Ticket not in expiry phase");
        require(!resolved, "Can't expire resolved ticket");
        emit Expired(_beneficiary);
        _selfDestruct(_beneficiary);
    }

    /// @notice cancel the ticket
    function cancel() external onlyAMM returns (uint) {
        require(!paused, "Market paused");

        finalPayout = buyInAmount;
        collateral.safeTransfer(address(ticketOwner), finalPayout);

        uint balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            collateral.safeTransfer(address(sportsAMM), balance);
        }

        _resolve(true, true);
        return finalPayout;
    }

    /// @notice withdraw collateral from the ticket
    function withdrawCollateral(address recipient) external onlyAMM {
        collateral.safeTransfer(recipient, collateral.balanceOf(address(this)));
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _resolve(bool _hasUserWon, bool _cancelled) internal {
        resolved = true;
        cancelled = _cancelled;
        emit Resolved(_hasUserWon, _cancelled);
    }

    function _selfDestruct(address beneficiary) internal {
        uint balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            collateral.safeTransfer(beneficiary, balance);
        }
    }

    function _isUserTheWinner() internal view returns (bool hasUserWon) {
        if (areAllMarketsResolved()) {
            hasUserWon = !isTicketLost();
        }
    }

    /* ========== SETTERS ========== */

    function setPaused(bool _paused) external {
        require(msg.sender == address(sportsAMM.manager()), "Invalid sender");
        if (paused == _paused) return;
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
