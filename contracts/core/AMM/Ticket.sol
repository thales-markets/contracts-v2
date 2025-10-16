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
        uint8 _systemBetDenominator;
        bool _isSGP;
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

    bool public isSystem;

    uint8 public systemBetDenominator;

    bool public isSGP;

    bool public isMarkedAsLost;

    uint public expectedFinalPayout;

    /* ========== CONSTRUCTOR and INITIALIZERS========== */

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
        systemBetDenominator = params._systemBetDenominator;
        isSystem = systemBetDenominator > 0;
        isSGP = params._isSGP;
    }

    /**
     * @notice Sets the expected final payout amount for this ticket.
     * @dev
     * - Can only be called by the SportsAMM contract.
     * - This value represents the total amount of collateral (including fees)
     *   that was initially funded to the ticket upon creation.
     * - Used later in `exercise()` to prevent manipulation or overfunding attacks,
     *   ensuring payout calculations rely only on the original committed collateral
     *   and not on the current token balance of the contract.
     * - Once set, this value should remain constant throughout the ticket lifecycle.
     *
     * @param amount The total expected collateral amount that should be held by this ticket.
     *               Must include both user buy-in and fees.
     *
     * Emits a {ExpectedFinalPayoutSet} event.
     */
    function setExpectedFinalPayout(uint amount) external onlyAMM {
        expectedFinalPayout = amount;
        emit ExpectedFinalPayoutSet(amount);
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice checks if the user lost the ticket
    /// @return isTicketLost true/false
    function isTicketLost() public view returns (bool) {
        if (isMarkedAsLost) {
            return true;
        } else {
            uint lostMarketsCount = 0;
            for (uint i = 0; i < numOfMarkets; i++) {
                (bool isMarketResolved, bool isWinningMarketPosition) = sportsAMM
                    .resultManager()
                    .isMarketResolvedAndPositionWinning(
                        markets[i].gameId,
                        markets[i].typeId,
                        markets[i].playerId,
                        markets[i].line,
                        markets[i].position,
                        markets[i].combinedPositions
                    );
                if (isMarketResolved && !isWinningMarketPosition) {
                    if (!isSystem) {
                        return true;
                    } else {
                        lostMarketsCount++;
                        if (lostMarketsCount > (numOfMarkets - systemBetDenominator)) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
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

    /// @notice return the payout for this ticket
    /// @return systemBetPayout the payout for this ticket
    function getSystemBetPayout() external view returns (uint systemBetPayout) {
        systemBetPayout = _getSystemBetPayout();
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice exercise ticket
    function exercise(address _exerciseCollateral) external onlyAMM notPaused returns (uint) {
        bool isExercisable = isTicketExercisable();
        require(isExercisable, "Ticket not exercisable yet");

        uint payoutWithFees = expectedFinalPayout;
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
                    if (isSGP) {
                        isCancelled = true;
                        break;
                    }
                    finalPayout = (finalPayout * markets[i].odd) / ONE;
                } else {
                    isCancelled = false;
                }
            }

            finalPayout = isCancelled ? buyInAmount : (isSystem ? _getSystemBetPayout() : finalPayout);

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
    function cancel() external onlyAMM notPaused returns (uint) {
        finalPayout = buyInAmount;
        collateral.safeTransfer(address(ticketOwner), finalPayout);

        uint balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            collateral.safeTransfer(address(sportsAMM), balance);
        }

        _resolve(true, true);
        return finalPayout;
    }

    /// @notice mark the ticket as lost
    function markAsLost() external onlyAMM notPaused returns (uint) {
        uint balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            collateral.safeTransfer(address(sportsAMM), balance);
        }

        _resolve(false, false);
        isMarkedAsLost = true;
        return 0;
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

    /* ========== SYSTEM BET UTILS ========== */

    function _getSystemBetPayout() internal view returns (uint systemBetPayout) {
        if (isSystem) {
            uint8[][] memory systemCombinations = sportsAMM.riskManager().generateCombinations(
                uint8(numOfMarkets),
                systemBetDenominator
            );
            uint totalCombinations = systemCombinations.length;
            uint buyinPerCombination = ((buyInAmount * ONE) / totalCombinations) / ONE;

            bool[] memory winningMarkets = new bool[](numOfMarkets);
            bool[] memory cancelledMarkets = new bool[](numOfMarkets);

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
                    return 0;
                }
                winningMarkets[i] = sportsAMM.resultManager().isWinningMarketPosition(
                    markets[i].gameId,
                    markets[i].typeId,
                    markets[i].playerId,
                    markets[i].line,
                    markets[i].position,
                    markets[i].combinedPositions
                );

                cancelledMarkets[i] = sportsAMM.resultManager().isCancelledMarketPosition(
                    markets[i].gameId,
                    markets[i].typeId,
                    markets[i].playerId,
                    markets[i].line,
                    markets[i].position,
                    markets[i].combinedPositions
                );
            }

            // Loop through each stored combination
            for (uint i = 0; i < totalCombinations; i++) {
                uint8[] memory currentCombination = systemCombinations[i];

                uint combinationQuote = ONE;

                for (uint j = 0; j < currentCombination.length; j++) {
                    uint8 marketIndex = currentCombination[j];
                    if (winningMarkets[marketIndex]) {
                        if (!cancelledMarkets[marketIndex]) {
                            combinationQuote = (combinationQuote * markets[marketIndex].odd) / ONE;
                        }
                    } else {
                        combinationQuote = 0;
                        break;
                    }
                }

                if (combinationQuote > 0) {
                    uint combinationPayout = (buyinPerCombination * ONE) / combinationQuote;
                    systemBetPayout += combinationPayout;
                }
            }

            uint maxPayout = (buyInAmount * ONE) / totalQuote;
            if (systemBetPayout > maxPayout) {
                systemBetPayout = maxPayout;
            }
        }
    }

    /* ========== MODIFIERS ========== */

    modifier onlyAMM() {
        require(msg.sender == address(sportsAMM), "Only the AMM may perform these methods");
        _;
    }

    modifier notPaused() {
        require(!paused, "Market paused");
        _;
    }

    /* ========== EVENTS ========== */

    event Resolved(bool isUserTheWinner, bool cancelled);
    event Expired(address beneficiary);
    event PauseUpdated(bool paused);
    event ExpectedFinalPayoutSet(uint amount);
}
