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

    bool public cashedOut;
    uint public cashoutPayout;

    // Snapshot of approved cashout odds at the moment of cashout
    mapping(uint => uint) private cashoutOddsPerLeg;

    // Whether the leg was already settled when cashout happened
    mapping(uint => bool) private cashoutWasSettledPerLeg;

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

    /**
     * @notice Returns whether a specific leg (market) of this ticket is resolved onchain.
     * @dev
     * - Uses the SportsAMM ResultManager as the source of truth.
     * - Intended for cashout flows where slippage checks should apply only to
     *   legs that are still pending (unresolved).
     * - Reverts if `_marketIndex` is out of bounds.
     *
     * @param _marketIndex Index of the leg/market in this ticket (0..numOfMarkets-1).
     * @return isResolved True if the underlying market is resolved, false otherwise.
     */
    function isLegResolved(uint _marketIndex) external view returns (bool isResolved) {
        require(_marketIndex < numOfMarkets, "Invalid market index");

        MarketData memory m = markets[_marketIndex];

        isResolved = sportsAMM.resultManager().isMarketResolved(m.gameId, m.typeId, m.playerId, m.line, m.combinedPositions);
    }

    /**
     * @notice Returns whether a specific leg of the ticket is voided (cancelled).
     * @dev Queries the ResultManager for cancellation status of the leg’s market position.
     *      Reverts if `_marketIndex` is out of bounds.
     * @param _marketIndex Index of the leg (0..numOfMarkets-1).
     * @return True if the leg is cancelled/voided, false otherwise.
     */
    function isLegVoided(uint _marketIndex) external view returns (bool) {
        require(_marketIndex < numOfMarkets, "Invalid market index");
        MarketData memory m = markets[_marketIndex];
        return
            sportsAMM.resultManager().isCancelledMarketPosition(
                m.gameId,
                m.typeId,
                m.playerId,
                m.line,
                m.position,
                m.combinedPositions
            );
    }

    /**
     * @notice Returns the stored odd for a given leg (market) on this ticket.
     * @dev Safer than relying on the autogenerated mapping getter because MarketData contains a dynamic array.
     * @param _marketIndex Index of the leg/market in this ticket (0..numOfMarkets-1).
     * @return odd Stored odd (18 decimals implied probability).
     */
    function getMarketOdd(uint _marketIndex) external view returns (uint odd) {
        require(_marketIndex < numOfMarkets, "Invalid market index");
        return markets[_marketIndex].odd;
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

    /**
     * @notice Computes the cashout quote, payout after fee, and fee amount.
     * @dev Uses `approvedOddsPerLeg` for pending legs and stored odds for settled
     *      (or 1 for voided) legs. Applies cashout fee as
     *      `safeBoxFee * cashoutFeeMultiplier`.
     * @param approvedOddsPerLeg Approved per-leg implied probabilities (1e18).
     * @param isLegSettled Flags indicating whether each leg is settled.
     * @return cashoutQuote Combined implied probability for cashout.
     * @return payoutAfterFee Cashout payout after fee deduction.
     */
    function getCashoutQuoteAndPayout(
        uint[] calldata approvedOddsPerLeg,
        bool[] calldata isLegSettled
    ) external view returns (uint cashoutQuote, uint payoutAfterFee) {
        uint legs = numOfMarkets;
        require(approvedOddsPerLeg.length == legs && isLegSettled.length == legs, "Invalid leg arrays length");

        (uint origProbTotal, uint liveProbTotal, uint remainingLegs, bool cashoutable) = _cashoutProbTotals(
            approvedOddsPerLeg,
            isLegSettled
        );

        if (!cashoutable || origProbTotal == 0) {
            return (0, 0);
        }

        // 1) Fair cashout multiplier (before vig): ratio = live/orig
        uint ratio = (liveProbTotal * ONE) / origProbTotal; // 1e18

        // 2) Compound vig: keepMultiplier = (1 - v)^n
        uint keepMultiplier = _cashoutKeepMultiplier(remainingLegs);

        cashoutQuote = (ratio * keepMultiplier) / ONE; // 1e18
        payoutAfterFee = (buyInAmount * cashoutQuote) / ONE;
    }

    /**
     * @notice Returns stored cashout data for all legs.
     * @return approvedOddsPerLeg Approved odds used for each leg during cashout
     * @return wasSettledPerLeg Whether each leg was settled at the time of cashout
     */
    function getCashoutPerLegData()
        external
        view
        returns (uint[] memory approvedOddsPerLeg, bool[] memory wasSettledPerLeg)
    {
        require(cashedOut, "Ticket not cashed out");

        uint legs = numOfMarkets;

        approvedOddsPerLeg = new uint[](legs);
        wasSettledPerLeg = new bool[](legs);

        for (uint i; i < legs; ++i) {
            approvedOddsPerLeg[i] = cashoutOddsPerLeg[i];
            wasSettledPerLeg[i] = cashoutWasSettledPerLeg[i];
        }
    }

    function _cashoutProbTotals(
        uint[] calldata approvedOddsPerLeg,
        bool[] calldata isLegSettled
    ) internal view returns (uint origProbTotal, uint liveProbTotal, uint remainingLegs, bool cashoutable) {
        uint legs = numOfMarkets;

        origProbTotal = ONE;
        liveProbTotal = ONE;
        remainingLegs = 0;

        ISportsAMMV2ResultManager resultManager = sportsAMM.resultManager();

        for (uint i = 0; i < legs; ++i) {
            MarketData memory m = markets[i];

            bool cancelledPos = resultManager.isCancelledMarketPosition(
                m.gameId,
                m.typeId,
                m.playerId,
                m.line,
                m.position,
                m.combinedPositions
            );

            bool resolvedMarket = resultManager.isMarketResolved(
                m.gameId,
                m.typeId,
                m.playerId,
                m.line,
                m.combinedPositions
            );

            // Settled = resolved OR cancelled
            require(isLegSettled[i] == (resolvedMarket || cancelledPos), "Invalid isLegSettled");

            // -------- ORIGINAL contribution (void legs omitted) --------
            uint origLegProb = cancelledPos ? ONE : m.odd;
            require(origLegProb > 0, "Invalid stored odd");
            origProbTotal = (origProbTotal * origLegProb) / ONE;

            // -------- LIVE contribution --------
            uint liveLegProb;

            if (cancelledPos) {
                // voided leg omitted from remaining risk
                liveLegProb = ONE;
            } else if (resolvedMarket) {
                // resolved: if losing -> not cashoutable
                bool isWinning = resultManager.isWinningMarketPosition(
                    m.gameId,
                    m.typeId,
                    m.playerId,
                    m.line,
                    m.position,
                    m.combinedPositions
                );

                if (!isWinning) {
                    return (0, 0, 0, false);
                }

                // already won leg => omitted from remaining risk
                liveLegProb = ONE;
            } else {
                // pending leg => live approved prob
                liveLegProb = approvedOddsPerLeg[i];
                require(liveLegProb > 0, "Invalid approved odd");
                remainingLegs++;
            }

            liveProbTotal = (liveProbTotal * liveLegProb) / ONE;
        }

        cashoutable = true;
    }

    function _cashoutKeepMultiplier(uint remainingLegs) internal view returns (uint keepMultiplier) {
        uint safeBoxFee = sportsAMM.safeBoxFee(); // 1e18 fraction (e.g. 0.01e18)
        uint multiplier = sportsAMM.riskManager().getCashoutSafeBoxFeeMultiplier(); // e.g. 5
        uint perLegVig = safeBoxFee * multiplier; // 1e18 fraction (e.g. 0.05e18)
        require(perLegVig < ONE, "Invalid vig");

        uint oneMinusV = ONE - perLegVig;

        keepMultiplier = ONE;
        for (uint k = 0; k < remainingLegs + 1; ++k) {
            keepMultiplier = (keepMultiplier * oneMinusV) / ONE;
        }
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice exercise ticket
    function exercise(address _exerciseCollateral) external onlyAMM notPaused returns (uint) {
        bool isExercisable = isTicketExercisable();
        require(isExercisable, "Ticket not exercisable yet");
        require(expectedFinalPayout > 0, "Expected final payout not set");

        uint payoutWithFees = expectedFinalPayout;
        uint payout = payoutWithFees - fees;
        bool isCancelled = false;

        ISportsAMMV2ResultManager resultManager = sportsAMM.resultManager();

        if (_isUserTheWinner()) {
            finalPayout = payout;
            isCancelled = true;
            for (uint i = 0; i < numOfMarkets; i++) {
                bool isCancelledMarketPosition = resultManager.isCancelledMarketPosition(
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

    /// @notice cash out the ticket for a given amount (amount is computed/validated in AMM)
    /// @dev callable only by AMM; resolves the ticket immediately
    function cashout(uint _cashoutAmount, address _recipient) external onlyAMM notPaused returns (uint) {
        require(!resolved, "Ticket already resolved");
        require(_cashoutAmount > 0, "Invalid cashout amount");
        require(_recipient != address(0), "Invalid recipient");
        require(expectedFinalPayout > 0, "Expected final payout not set");
        require(phase() == Phase.Trading, "Not in trading phase");
        require(!isSystem && !isSGP, "Not possible for System bets or SGPs");

        // Hard rule: cannot cashout if already lost (same as AMM check, defense-in-depth)
        require(!isTicketLost(), "Ticket lost");

        // Cap: don't allow paying more than max user payout (expectedFinalPayout includes fees)
        uint cap = expectedFinalPayout > fees ? (expectedFinalPayout - fees) : 0;
        require(_cashoutAmount <= cap, "Cashout exceeds cap");

        cashoutPayout = _cashoutAmount;
        finalPayout = _cashoutAmount;
        cashedOut = true;

        // Pay user
        collateral.safeTransfer(_recipient, _cashoutAmount);

        // Send remainder back to AMM (same behavior as exercise/cancel)
        uint balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            collateral.safeTransfer(address(sportsAMM), balance);
        }

        // Resolve as "not cancelled" (cashout is its own thing)
        _resolve(true, false);

        emit CashedOut(_recipient, _cashoutAmount);

        return _cashoutAmount;
    }

    /**
     * @notice Stores the approved cashout odds and settled flags per leg.
     * @dev Callable only by AMM. Intended to be called immediately before successful cashout.
     * @param _approvedOddsPerLeg Approved cashout odds per leg.
     * @param _isLegSettled Whether each leg was settled at cashout time.
     */
    function setCashoutPerLegData(
        uint[] calldata _approvedOddsPerLeg,
        bool[] calldata _isLegSettled
    ) external onlyAMM notPaused {
        require(!resolved, "Ticket already resolved");

        uint legs = numOfMarkets;
        require(_approvedOddsPerLeg.length == legs, "Invalid approved odds length");
        require(_isLegSettled.length == legs, "Invalid settled flags length");

        for (uint i = 0; i < legs; ++i) {
            cashoutOddsPerLeg[i] = _approvedOddsPerLeg[i];
            cashoutWasSettledPerLeg[i] = _isLegSettled[i];
        }
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
    event CashedOut(address recipient, uint amount);
}
