// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

// internal
import "../../interfaces/ISportsAMMV2.sol";
import "../../core/AMM/Ticket.sol";

/**
 * @title CashoutProcessor
 * @notice Quote-based cashout processor with per-leg odds (implied probability, 18 decimals).
 * @dev
 * Handles voided legs: for legs already voided onchain, expected/approved odd must be 1e18.
 * For resolved (non-void) legs, expected/approved odd must equal ticket stored odd.
 * For pending legs, approved odd must satisfy per-leg slippage vs expected odd.
 */
contract CashoutProcessor is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;

    uint private constant ONE = 1e18;

    ISportsAMMV2 public sportsAMM;

    bytes32 public jobSpecId;
    uint public paymentAmount;

    uint public maxAllowedExecutionDelay = 60;

    // ===== Requests =====
    mapping(bytes32 => address) public requestIdToTicket;
    mapping(bytes32 => address) public requestIdToRequester;

    // user slippage params (per-leg)
    mapping(bytes32 => uint) public requestIdToAdditionalSlippage;

    // user-provided expected legs data
    mapping(bytes32 => uint[]) internal _requestIdToExpectedOddsPerLeg;
    mapping(bytes32 => bool[]) internal _requestIdToIsLegResolved;

    mapping(bytes32 => uint) public timestampPerRequest;

    mapping(bytes32 => bool) public requestIdFulfilled;
    mapping(bytes32 => bool) public requestIdToFulfillAllowed;

    // store approved odds for UI/debugging
    mapping(bytes32 => uint[]) internal _requestIdToApprovedOddsPerLeg;

    uint public requestCounter;
    mapping(uint => bytes32) public counterToRequestId;

    /// @notice Free bets holder address; tickets owned by this contract are NOT cashoutable for now.
    address public freeBetsHolder;

    // ===== Errors =====
    error RequestAlreadyFulfilled();
    error RequestTimedOut();
    error InvalidTicket();
    error InvalidExpectedOdds();
    error InvalidLegArraysLength();
    error CashoutNotAllowed();
    error NotOwner();
    error TicketNotCashoutable();
    error LegStatusMismatch();
    error SettledLegOddMismatch();
    error SlippageTooHigh();

    constructor(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        uint _paymentAmount
    ) Ownable(msg.sender) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);

        sportsAMM = ISportsAMMV2(_sportsAMM);
        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;
    }

    // ============================
    // User entrypoint
    // ============================

    /**
     * @notice Request a cashout quote for a ticket using per-leg odds.
     * @dev
     * - `expectedOddsPerLeg` is per-leg implied probability (18 decimals).
     * - `isLegResolved` is user assertion; verified against onchain truth.
     * - Slippage applies per *pending* leg: approvedOdd <= expectedOdd * (1 + additionalSlippage).
     * - Voided legs: expected odd must be 1e18.
     *
     * @param ticket Ticket address to cash out.
     * @param expectedOddsPerLeg Expected odds per leg (18 decimals).
     * @param isLegResolved User-asserted leg resolved flags.
     * @param additionalSlippage Slippage tolerance in 18 decimals (e.g. 0.01e18 for 1%).
     */
    function requestCashout(
        address ticket,
        uint[] calldata expectedOddsPerLeg,
        bool[] calldata isLegResolved,
        uint additionalSlippage
    ) external whenNotPaused returns (bytes32 requestId) {
        if (ticket == address(0)) revert InvalidTicket();

        uint legs = expectedOddsPerLeg.length;
        if (legs == 0) revert InvalidExpectedOdds();
        if (isLegResolved.length != legs) revert InvalidLegArraysLength();

        // Best-effort preflight checks (final enforcement must still be in SportsAMM + Ticket.cashout())
        _assertTicketLooksCashoutable(ticket, msg.sender);

        // Verify user didn't lie about leg statuses AND resolved-leg expected odds match ticket stored odds
        // AND voided legs expected odd == 1e18
        _verifyLegStatusesAndResolvedOdds(ticket, expectedOddsPerLeg, isLegResolved);

        Chainlink.Request memory req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillCashout.selector);

        // Minimal payload: adapter can read full ticket state via RPC
        req.add("mode", "ticket");
        req.add("ticket", Strings.toHexString(ticket));
        req.add("requester", Strings.toHexString(msg.sender));

        // Arrays are passed as strings for adapter parsing (keep consistent with your adapter conventions).
        req.add("expectedOddsPerLeg", _uintArrayToString(expectedOddsPerLeg));
        req.add("isLegResolved", _boolArrayToString(isLegResolved));

        req.addUint("additionalSlippage", additionalSlippage);

        requestId = sendChainlinkRequest(req, paymentAmount);

        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTicket[requestId] = ticket;
        requestIdToRequester[requestId] = msg.sender;

        requestIdToAdditionalSlippage[requestId] = additionalSlippage;

        // store request arrays for fulfill-time checks
        _requestIdToExpectedOddsPerLeg[requestId] = expectedOddsPerLeg;
        _requestIdToIsLegResolved[requestId] = isLegResolved;

        counterToRequestId[requestCounter] = requestId;
        emit CashoutRequested(msg.sender, requestCounter, requestId, ticket, legs, additionalSlippage);
        requestCounter++;
    }

    // ============================
    // Chainlink fulfillment
    // ============================

    /**
     * @notice Chainlink callback with cashout decision and approved odds per leg.
     * @dev Approved odds are per-leg implied probability (18 decimals).
     *      Voided legs must be 1e18.
     *
     * @param _requestId Request id.
     * @param _allow Whether cashout is allowed.
     * @param _approvedOddsPerLeg Approved odds per leg (18 decimals).
     */
    function fulfillCashout(
        bytes32 _requestId,
        bool _allow,
        uint[] calldata _approvedOddsPerLeg
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        if (requestIdFulfilled[_requestId]) revert RequestAlreadyFulfilled();
        if ((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) <= block.timestamp) revert RequestTimedOut();

        address ticketAddr = requestIdToTicket[_requestId];
        address requester = requestIdToRequester[_requestId];

        uint additionalSlippage = requestIdToAdditionalSlippage[_requestId];

        uint[] storage expectedOddsPerLeg = _requestIdToExpectedOddsPerLeg[_requestId];
        bool[] storage isLegResolved = _requestIdToIsLegResolved[_requestId];

        uint legs = expectedOddsPerLeg.length;
        if (legs == 0) revert InvalidExpectedOdds();
        if (_approvedOddsPerLeg.length != legs) revert InvalidLegArraysLength();

        // store fulfillment outcome for UI/debugging
        requestIdToFulfillAllowed[_requestId] = _allow;
        requestIdFulfilled[_requestId] = true;

        // copy approved odds for UI/debugging
        _requestIdToApprovedOddsPerLeg[_requestId] = _approvedOddsPerLeg;

        if (!_allow) revert CashoutNotAllowed();

        // Edge-case defense: verify user still didn't lie (leg may have resolved/voided between request & fulfill),
        // and ensure resolved-leg expected odds still match ticket odds; voided legs expected == 1e18.
        _verifyLegStatusesAndResolvedOdds(ticketAddr, expectedOddsPerLeg, isLegResolved);

        // Verify:
        // - voided legs: approved must be 1e18
        // - resolved (non-void) legs: approved must equal ticket stored odd
        // - pending legs: approved must satisfy per-leg slippage vs expected
        _verifyApprovedOddsAndPerLegSlippage(
            ticketAddr,
            _approvedOddsPerLeg,
            expectedOddsPerLeg,
            isLegResolved,
            additionalSlippage
        );

        // Execute via AMM
        sportsAMM.cashoutTicketWithLegOdds(ticketAddr, _approvedOddsPerLeg, isLegResolved, requester);

        emit CashoutFulfilled(requester, _requestId, ticketAddr, _allow, legs, block.timestamp);
    }

    // ============================
    // Internal helpers
    // ============================

    /**
     * @dev Best-effort preflight checks. Final checks must be in SportsAMMV2.cashoutTicketWithLegOdds + Ticket.cashout().
     */
    function _assertTicketLooksCashoutable(address ticketAddr, address requester) internal view {
        Ticket t = Ticket(ticketAddr);

        if (t.ticketOwner() != requester) revert NotOwner();

        if (!sportsAMM.manager().isActiveTicket(ticketAddr)) revert TicketNotCashoutable();

        if (
            t.resolved() ||
            t.isTicketLost() ||
            t.isSGP() ||
            t.systemBetDenominator() > 1 ||
            (freeBetsHolder != address(0) && t.ticketOwner() == freeBetsHolder) ||
            !sportsAMM.manager().isTicketPotentiallyCashoutable(ticketAddr)
        ) revert TicketNotCashoutable();
    }

    /**
     * @dev Verifies user did not lie about which legs are resolved.
     * Also:
     * - if leg is voided onchain => expected odd MUST be 1e18
     * - else if leg is resolved (non-void) => expected odd MUST equal ticket stored odd
     *
     * Edge-case: if a leg flips to resolved/voided between request and fulfill,
     * user assertion will mismatch and revert.
     */
    function _verifyLegStatusesAndResolvedOdds(
        address ticketAddr,
        uint[] memory expectedOddsPerLeg,
        bool[] memory isLegResolved
    ) internal view {
        Ticket t = Ticket(ticketAddr);
        uint legs = expectedOddsPerLeg.length;

        for (uint i = 0; i < legs; ++i) {
            uint expectedOdd = expectedOddsPerLeg[i];
            if (expectedOdd == 0) revert InvalidExpectedOdds();

            bool resolvedOnchain = t.isLegResolved(i);

            if (resolvedOnchain != isLegResolved[i]) revert LegStatusMismatch();

            if (resolvedOnchain) {
                bool voided = t.isLegVoided(i);
                if (voided) {
                    if (expectedOdd != ONE) revert SettledLegOddMismatch();
                } else {
                    uint ticketOdd = t.getMarketOdd(i);
                    if (expectedOdd != ticketOdd) revert SettledLegOddMismatch();
                }
            }
        }
    }

    /**
     * @dev Verifies approved odds and per-leg slippage:
     * - resolved+voided: approved MUST be 1e18
     * - resolved (non-void): approved MUST equal ticket stored odd
     * - pending: approved MUST be <= expected * (1 + additionalSlippage)
     */
    function _verifyApprovedOddsAndPerLegSlippage(
        address ticketAddr,
        uint[] calldata approvedOddsPerLeg,
        uint[] memory expectedOddsPerLeg,
        bool[] memory isLegResolved,
        uint additionalSlippage
    ) internal view {
        Ticket t = Ticket(ticketAddr);
        uint legs = approvedOddsPerLeg.length;

        for (uint i = 0; i < legs; ++i) {
            uint approved = approvedOddsPerLeg[i];
            uint expected = expectedOddsPerLeg[i];
            if (approved == 0 || expected == 0) revert InvalidExpectedOdds();

            bool resolvedOnchain = t.isLegResolved(i);
            if (resolvedOnchain != isLegResolved[i]) revert LegStatusMismatch();

            if (resolvedOnchain) {
                bool voided = t.isLegVoided(i);
                if (voided) {
                    if (approved != ONE) revert SettledLegOddMismatch();
                } else {
                    uint ticketOdd = t.getMarketOdd(i);
                    if (approved != ticketOdd) revert SettledLegOddMismatch();
                }
            } else {
                uint maxApproved = (expected * (ONE + additionalSlippage)) / ONE;
                if (approved > maxApproved) revert SlippageTooHigh();
            }
        }
    }

    // ============================
    // Admin
    // ============================

    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    function setConfiguration(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        uint _paymentAmount
    ) external onlyOwner {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);

        sportsAMM = ISportsAMMV2(_sportsAMM);
        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;

        emit ContextReset(_link, _oracle, _sportsAMM, _jobSpecId, _paymentAmount);
    }

    /// @notice Sets the FreeBetsHolder address; tickets owned by this contract are not cashoutable.
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    /// @notice Sets maximum allowed buffer for the Chainlink request to be executed (seconds).
    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    // ============================
    // View helpers
    // ============================

    function getRequestBasics(
        bytes32 requestId
    )
        external
        view
        returns (address ticket, address requester, uint additionalSlippage, uint ts, bool fulfilled, bool allow)
    {
        ticket = requestIdToTicket[requestId];
        requester = requestIdToRequester[requestId];
        additionalSlippage = requestIdToAdditionalSlippage[requestId];
        ts = timestampPerRequest[requestId];
        fulfilled = requestIdFulfilled[requestId];
        allow = requestIdToFulfillAllowed[requestId];
    }

    function getRequestArrays(
        bytes32 requestId
    )
        external
        view
        returns (uint[] memory expectedOddsPerLeg, bool[] memory isLegResolved, uint[] memory approvedOddsPerLeg)
    {
        expectedOddsPerLeg = _requestIdToExpectedOddsPerLeg[requestId];
        isLegResolved = _requestIdToIsLegResolved[requestId];
        approvedOddsPerLeg = _requestIdToApprovedOddsPerLeg[requestId];
    }

    // ============================
    // Small encoding helpers for adapter payload
    // ============================

    function _uintArrayToString(uint[] calldata arr) internal pure returns (string memory) {
        uint len = arr.length;
        if (len == 0) return "";

        bytes memory out;
        for (uint i = 0; i < len; i++) {
            out = bytes.concat(out, bytes(Strings.toString(arr[i])));
            if (i + 1 < len) out = bytes.concat(out, bytes(","));
        }
        return string(out);
    }

    function _boolArrayToString(bool[] calldata arr) internal pure returns (string memory) {
        uint len = arr.length;
        if (len == 0) return "";

        bytes memory out;
        for (uint i = 0; i < len; i++) {
            out = bytes.concat(out, arr[i] ? bytes("1") : bytes("0"));
            if (i + 1 < len) out = bytes.concat(out, bytes(","));
        }
        return string(out);
    }

    // ============================
    // Events
    // ============================

    event ContextReset(address link, address oracle, address sportsAMM, bytes32 jobSpecId, uint paymentAmount);

    event CashoutRequested(
        address indexed requester,
        uint indexed requestCounter,
        bytes32 indexed requestId,
        address ticket,
        uint legs,
        uint additionalSlippage
    );

    event CashoutFulfilled(
        address indexed requester,
        bytes32 indexed requestId,
        address ticket,
        bool allow,
        uint legs,
        uint timestamp
    );

    event SetMaxAllowedExecutionDelay(uint delay);
    event SetFreeBetsHolder(address _freeBetsHolder);
}
