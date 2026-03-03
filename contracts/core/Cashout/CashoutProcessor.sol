// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

// internal
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../core/AMM/Ticket.sol";

/**
 * @title CashoutProcessor
 * @notice Chainlink-powered cashout gatekeeper for SportsAMMV2 tickets using per-leg odds.
 * @dev
 * High-level flow:
 * 1) User calls {requestCashout} supplying:
 *    - `expectedOddsPerLeg`: user-expected implied probabilities per leg (18 decimals).
 *    - `isLegResolved`: user-asserted resolved/pending flags per leg.
 *    - `additionalSlippage`: max allowed increase vs expected odds for *pending* legs (18-decimal percentage).
 * 2) Contract validates the ticket is cashout-eligible and that the user did not lie about leg status / settled odds.
 * 3) Contract submits a Chainlink request to an offchain adapter to compute `approvedOddsPerLeg` and an allow/deny flag.
 * 4) Oracle calls {fulfillCashout}:
 *    - re-checks leg status / settled odds again (defense-in-depth),
 *    - enforces per-leg slippage for pending legs,
 *    - then calls `sportsAMM.cashoutTicketWithLegOdds(...)` if allowed.
 *
 * Security model notes:
 * - Uses Chainlink's `recordChainlinkFulfillment` to restrict fulfill calls to the configured oracle + requestId.
 * - Reverts on `_allow=false` to avoid executing AMM cashout.
 * - Enforces a maximum oracle execution delay (`maxAllowedExecutionDelay`) to reduce stale quote risk.
 * - Stores request data to allow UIs and indexers to display the request/response details.
 */
contract CashoutProcessor is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;

    /// @dev 18-decimal fixed-point scalar (also used as "1.0" for implied probability).
    uint private constant ONE = 1e18;

    /// @notice SportsAMM instance used to validate tickets and execute the cashout.
    ISportsAMMV2 public sportsAMM;

    /// @notice Chainlink job spec id used for the cashout quote adapter request.
    bytes32 public jobSpecId;

    /// @notice LINK payment amount for each request (in LINK smallest unit).
    uint public paymentAmount;

    /// @notice Max time (in seconds) allowed between request creation and fulfill execution.
    /// @dev Requests older than `timestampPerRequest + maxAllowedExecutionDelay` are rejected as stale.
    uint public maxAllowedExecutionDelay = 60;

    // ===== Requests =====

    /// @notice Maps requestId => ticket address.
    mapping(bytes32 => address) public requestIdToTicket;

    /// @notice Maps requestId => original requester (ticket owner) address.
    mapping(bytes32 => address) public requestIdToRequester;

    /// @notice Maps requestId => additionalSlippage passed by the requester.
    mapping(bytes32 => uint) public requestIdToAdditionalSlippage;

    /// @dev Maps requestId => expected odds per leg provided by the requester.
    mapping(bytes32 => uint[]) internal _requestIdToExpectedOddsPerLeg;

    /// @dev Maps requestId => resolved flags per leg provided by the requester.
    mapping(bytes32 => bool[]) internal _requestIdToIsLegResolved;

    /// @notice Maps requestId => timestamp at which request was stored (block.timestamp).
    mapping(bytes32 => uint) public timestampPerRequest;

    /// @notice True if request has been fulfilled already.
    mapping(bytes32 => bool) public requestIdFulfilled;

    /// @notice Oracle allow/deny decision per requestId (written in fulfill).
    mapping(bytes32 => bool) public requestIdToFulfillAllowed;

    /// @dev Maps requestId => approved odds per leg returned by oracle (stored for UI/debugging).
    mapping(bytes32 => uint[]) internal _requestIdToApprovedOddsPerLeg;

    /// @notice Monotonic counter for requests (useful for offchain indexing).
    uint public requestCounter;

    /// @notice Maps a sequential counter => requestId.
    mapping(uint => bytes32) public counterToRequestId;

    /// @notice Optional FreeBetsHolder address; tickets owned by this address are not cashoutable.
    address public freeBetsHolder;

    // ===== Errors =====

    /// @notice Request already fulfilled (replay protection).
    error RequestAlreadyFulfilled();

    /// @notice Request exceeded maxAllowedExecutionDelay.
    error RequestTimedOut();

    /// @notice Ticket address is invalid (e.g., zero address).
    error InvalidTicket();

    /// @notice Odds array invalid (e.g., empty or contains zeros where not allowed).
    error InvalidExpectedOdds();

    /// @notice Provided per-leg arrays lengths do not match.
    error InvalidLegArraysLength();

    /// @notice Oracle decided cashout is not allowed.
    error CashoutNotAllowed();

    /// @notice Caller is not the ticket owner.
    error NotOwner();

    /// @notice Ticket fails cashout eligibility checks.
    error TicketNotCashoutable();

    /// @notice User-provided resolved flags do not match onchain status.
    error LegStatusMismatch();

    /// @notice For settled legs, provided odd does not match ticket's stored odd (or ONE for voided legs).
    error SettledLegOddMismatch();

    /// @notice Approved odds exceed expected odds by more than allowed slippage for a pending leg.
    error SlippageTooHigh();

    /**
     * @notice Creates CashoutProcessor and sets initial Chainlink + SportsAMM configuration.
     * @param _link LINK token address for the current network.
     * @param _oracle Chainlink oracle address that will fulfill requests.
     * @param _sportsAMM SportsAMMV2 address that performs the cashout settlement.
     * @param _jobSpecId Chainlink job spec id for the offchain adapter.
     * @param _paymentAmount LINK amount to pay per request.
     */
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
    // Request
    // ============================

    /**
     * @notice Requests a cashout quote/approval from the Chainlink adapter for a given ticket.
     * @dev
     * Validations performed before sending the oracle request:
     * - Ticket must be non-zero address.
     * - Arrays must be non-empty and have matching lengths.
     * - Caller must be the ticket owner and ticket must be active and cashout-eligible.
     * - Caller must not misrepresent leg status:
     *   - For any leg that is already resolved onchain, `isLegResolved[i]` must be true.
     *   - For resolved legs, `expectedOddsPerLeg[i]` must match the ticket's settled odd
     *     (or ONE if the leg is voided).
     *
     * The oracle request includes per-leg market identifiers and user-provided expectations:
     * `gameIds`, `typeIds`, `playerIds`, `positions`, `lines`, `expectedOddsPerLeg`, `isLegResolved`,
     * plus `additionalSlippage` and `requester`.
     *
     * @param ticket Ticket contract address.
     * @param expectedOddsPerLeg User-expected implied probabilities per leg (18 decimals). Must be > 0 for all legs.
     * @param isLegResolved User-asserted resolved flags per leg (must match onchain `Ticket.isLegResolved(i)`).
     * @param additionalSlippage Max allowed increase vs expected odds for pending legs (18-decimal percentage).
     * @return requestId The Chainlink request id for the created request.
     */
    function requestCashout(
        address ticket,
        uint[] calldata expectedOddsPerLeg,
        bool[] calldata isLegResolved,
        uint additionalSlippage
    ) external whenNotPaused returns (bytes32 requestId) {
        if (ticket == address(0)) revert InvalidTicket();

        uint legsLen = expectedOddsPerLeg.length;
        if (legsLen == 0) revert InvalidExpectedOdds();
        if (isLegResolved.length != legsLen) revert InvalidLegArraysLength();
        uint ticketLegs = Ticket(ticket).numOfMarkets();
        if (legsLen != ticketLegs) revert InvalidLegArraysLength();

        _assertTicketLooksCashoutable(ticket, msg.sender);

        _verifyLegStatusesAndSettledOdds(ticket, expectedOddsPerLeg, isLegResolved);

        Chainlink.Request memory req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillCashout.selector);

        // Adapter expects arrays (build each array in a separate frame to avoid stack-too-deep)
        _addLegArraysToRequest(req, ticket, legsLen, expectedOddsPerLeg, isLegResolved);

        req.addUint("additionalSlippage", additionalSlippage);
        req.add("requester", Strings.toHexString(msg.sender));

        requestId = sendChainlinkRequest(req, paymentAmount);

        _storeRequest(requestId, ticket, msg.sender, additionalSlippage, expectedOddsPerLeg, isLegResolved);

        emit CashoutRequested(msg.sender, requestCounter, requestId, ticket, legsLen, additionalSlippage);
        requestCounter++;
    }

    // ============================
    // Fulfill
    // ============================

    /**
     * @notice Chainlink fulfillment entrypoint that approves/denies and finalizes a cashout.
     * @dev
     * Access control:
     * - Restricted by `recordChainlinkFulfillment(_requestId)` which enforces oracle + requestId validity.
     *
     * Safety checks:
     * - Reverts if request already fulfilled (replay protection).
     * - Reverts if request is stale (older than `maxAllowedExecutionDelay`).
     * - Reverts if returned odds array length mismatches the expected legs length.
     *
     * If `_allow` is false, it stores the result and reverts with {CashoutNotAllowed}.
     *
     * If `_allow` is true, it:
     * - Re-checks leg status/settled odds to ensure nothing changed vs the request snapshot.
     * - Enforces per-leg slippage for pending legs: `approvedOdd <= expectedOdd*(1+slippage)`.
     * - Calls `sportsAMM.cashoutTicketWithLegOdds(...)`.
     *
     * @param _requestId Chainlink request id.
     * @param _allow Whether cashout is approved by the oracle/adaptor.
     * @param _approvedOddsPerLeg Per-leg approved implied probabilities (18 decimals). Must match legs length.
     */
    function fulfillCashout(
        bytes32 _requestId,
        bool _allow,
        uint[] calldata _approvedOddsPerLeg
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        if (requestIdFulfilled[_requestId]) revert RequestAlreadyFulfilled();
        if ((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) <= block.timestamp) revert RequestTimedOut();

        uint legsLen = _requestIdToExpectedOddsPerLeg[_requestId].length;
        if (legsLen == 0) revert InvalidExpectedOdds(); // safety (should never happen)
        if (_approvedOddsPerLeg.length != legsLen) revert InvalidLegArraysLength();

        // also ensure request arrays still match ticket legs
        address ticketAddr = requestIdToTicket[_requestId];
        uint ticketLegs = Ticket(ticketAddr).numOfMarkets();
        if (legsLen != ticketLegs) revert InvalidLegArraysLength();

        requestIdToFulfillAllowed[_requestId] = _allow;
        requestIdFulfilled[_requestId] = true;

        // store approved odds for UI/debugging (reverted back in)
        _requestIdToApprovedOddsPerLeg[_requestId] = _approvedOddsPerLeg;

        if (!_allow) revert CashoutNotAllowed();

        _verifyApprovedOddsAndPerLegSlippage(
            ticketAddr,
            _approvedOddsPerLeg,
            _requestIdToExpectedOddsPerLeg[_requestId],
            _requestIdToIsLegResolved[_requestId],
            requestIdToAdditionalSlippage[_requestId]
        );

        sportsAMM.cashoutTicketWithLegOdds(
            ticketAddr,
            _approvedOddsPerLeg,
            _requestIdToIsLegResolved[_requestId],
            requestIdToRequester[_requestId]
        );

        emit CashoutFulfilled(requestIdToRequester[_requestId], _requestId, ticketAddr, _allow, legsLen, block.timestamp);
    }

    // ============================
    // Internal Logic
    // ============================

    /**
     * @dev Persists request metadata and user-provided per-leg arrays for later verification and UI reads.
     * @param requestId Chainlink request id.
     * @param ticket Ticket address.
     * @param requester Original caller.
     * @param additionalSlippage User-provided additional slippage.
     * @param expectedOddsPerLeg User-provided expected odds per leg.
     * @param isLegResolved User-provided resolved flags per leg.
     */
    function _storeRequest(
        bytes32 requestId,
        address ticket,
        address requester,
        uint additionalSlippage,
        uint[] calldata expectedOddsPerLeg,
        bool[] calldata isLegResolved
    ) internal {
        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTicket[requestId] = ticket;
        requestIdToRequester[requestId] = requester;
        requestIdToAdditionalSlippage[requestId] = additionalSlippage;

        _requestIdToExpectedOddsPerLeg[requestId] = expectedOddsPerLeg;
        _requestIdToIsLegResolved[requestId] = isLegResolved;

        counterToRequestId[requestCounter] = requestId;
    }

    /**
     * @dev Ensures ticket meets basic eligibility requirements for cashout.
     * @param ticketAddr Ticket contract address.
     * @param requester Address attempting to cashout (must be ticket owner).
     *
     * Reverts with:
     * - {NotOwner} if requester != ticketOwner.
     * - {TicketNotCashoutable} if ticket is inactive, resolved/lost/SGP/system-bet,
     *   owned by freeBetsHolder, manager marks it as not potentially cashoutable,
     *   or if the ticket odds exceed (or equal) RiskManager.maxSupportedOdds().
     */
    function _assertTicketLooksCashoutable(address ticketAddr, address requester) internal view {
        Ticket t = Ticket(ticketAddr);
        ISportsAMMV2Manager mgr = sportsAMM.manager();

        if (t.ticketOwner() != requester) revert NotOwner();
        if (!mgr.isActiveTicket(ticketAddr)) revert TicketNotCashoutable();

        if (
            t.resolved() ||
            t.isTicketLost() ||
            t.isSGP() ||
            t.systemBetDenominator() > 1 ||
            (freeBetsHolder != address(0) && requester == freeBetsHolder) ||
            !mgr.isTicketPotentiallyCashoutable(ticketAddr) ||
            t.totalQuote() <= sportsAMM.riskManager().maxSupportedOdds()
        ) revert TicketNotCashoutable();
    }

    /**
     * @dev Enforces oracle-approved odds validity, leg-status consistency, and per-leg slippage for pending legs.
     * @param ticketAddr Ticket contract address.
     * @param approved Oracle-approved odds per leg (18 decimals).
     * @param expected User-expected odds per leg (18 decimals).
     * @param isLegResolved User-asserted resolved flags per leg (must still match onchain status).
     * @param slippage Max allowed increase vs expected for pending legs (18-decimal percentage).
     *
     * Rules per leg:
     * - `approvedOdd` and `expectedOdd` must be non-zero.
     * - Onchain resolved status must still equal `isLegResolved[i]`.
     * - If resolved: approved must match settled odd (or ONE if voided).
     * - If pending: `approvedOdd` must be <= `expectedOdd * (1 + slippage)`.
     */
    function _verifyApprovedOddsAndPerLegSlippage(
        address ticketAddr,
        uint[] calldata approved,
        uint[] memory expected,
        bool[] memory isLegResolved,
        uint slippage
    ) internal view {
        _verifyLegStatusesAndSettledOdds(ticketAddr, approved, isLegResolved);

        uint legs = approved.length;

        for (uint i = 0; i < legs; ++i) {
            uint expectedOdd = expected[i];
            if (expectedOdd == 0) revert InvalidExpectedOdds();

            if (!isLegResolved[i]) {
                uint maxApproved = (expectedOdd * (ONE + slippage)) / ONE;
                if (approved[i] > maxApproved) revert SlippageTooHigh();
            }
        }
    }

    /**
     * @dev Verifies per-leg resolved status and (if resolved) the settled odd against onchain Ticket data.
     *
     * Requirements per leg `i`:
     * - `odds[i]` must be non-zero.
     * - Onchain `Ticket.isLegResolved(i)` must equal `isLegResolved[i]` (prevents misreporting).
     * - If the leg is resolved:
     *   - if voided => `odds[i]` must equal ONE
     *   - else      => `odds[i]` must equal `Ticket.getMarketOdd(i)`
     *
     * Reverts with:
     * - {InvalidExpectedOdds} if any `odds[i] == 0`.
     * - {LegStatusMismatch} if provided status differs from onchain resolved status.
     * - {SettledLegOddMismatch} if a resolved leg's odd does not match the ticket's settled odd (or ONE for voided).
     *
     * @param ticketAddr Ticket contract address.
     * @param odds Per-leg odds to validate (expected odds during request, or approved odds during fulfill), 18 decimals.
     * @param isLegResolved User-provided resolved flags per leg; must match onchain `Ticket.isLegResolved(i)`.
     */
    function _verifyLegStatusesAndSettledOdds(
        address ticketAddr,
        uint[] memory odds,
        bool[] memory isLegResolved
    ) internal view {
        Ticket t = Ticket(ticketAddr);
        uint legs = odds.length;

        for (uint i = 0; i < legs; ++i) {
            uint odd = odds[i];
            if (odd == 0) revert InvalidExpectedOdds();

            bool resolved = t.isLegResolved(i);
            if (resolved != isLegResolved[i]) revert LegStatusMismatch();

            if (resolved) {
                if (t.isLegVoided(i)) {
                    if (odd != ONE) revert SettledLegOddMismatch();
                } else {
                    if (odd != t.getMarketOdd(i)) revert SettledLegOddMismatch();
                }
            }
        }
    }

    // ============================
    // Adapter array building (stack-safe)
    // ============================

    /**
     * @dev Adds all per-leg arrays required by the adapter to the Chainlink request.
     * @param req Chainlink request object (memory).
     * @param ticketAddr Ticket address.
     * @param legsLen Number of legs in the ticket.
     * @param expectedOddsPerLeg User-expected odds per leg.
     * @param isLegResolved User-asserted resolved flags per leg.
     */
    function _addLegArraysToRequest(
        Chainlink.Request memory req,
        address ticketAddr,
        uint legsLen,
        uint[] calldata expectedOddsPerLeg,
        bool[] calldata isLegResolved
    ) internal view {
        req.addStringArray("gameIds", _buildGameIds(ticketAddr, legsLen));
        req.addStringArray("typeIds", _buildTypeIds(ticketAddr, legsLen));
        req.addStringArray("playerIds", _buildPlayerIds(ticketAddr, legsLen));
        req.addStringArray("positions", _buildPositions(ticketAddr, legsLen));
        req.addStringArray("lines", _buildLines(ticketAddr, legsLen));
        req.addStringArray("expectedOddsPerLeg", _buildExpectedOdds(expectedOddsPerLeg, legsLen));
        req.addStringArray("isLegResolved", _buildIsResolved(isLegResolved, legsLen));
    }

    /// @dev Builds hex-encoded bytes32 gameIds for each leg.
    function _buildGameIds(address ticketAddr, uint legsLen) internal view returns (string[] memory out) {
        Ticket t = Ticket(ticketAddr);
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            (bytes32 gid, , , , , , , , ) = t.markets(i);
            out[i] = Strings.toHexString(uint256(gid), 32);
        }
    }

    /// @dev Builds decimal-encoded typeIds for each leg.
    function _buildTypeIds(address ticketAddr, uint legsLen) internal view returns (string[] memory out) {
        Ticket t = Ticket(ticketAddr);
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            (, , uint16 typeId, , , , , , ) = t.markets(i);
            out[i] = Strings.toString(uint256(typeId));
        }
    }

    /// @dev Builds decimal-encoded playerIds for each leg.
    function _buildPlayerIds(address ticketAddr, uint legsLen) internal view returns (string[] memory out) {
        Ticket t = Ticket(ticketAddr);
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            (, , , , , , uint24 playerId, , ) = t.markets(i);
            out[i] = Strings.toString(uint256(playerId));
        }
    }

    /// @dev Builds decimal-encoded positions for each leg.
    function _buildPositions(address ticketAddr, uint legsLen) internal view returns (string[] memory out) {
        Ticket t = Ticket(ticketAddr);
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            (, , , , , , , uint8 position, ) = t.markets(i);
            out[i] = Strings.toString(uint256(position));
        }
    }

    /// @dev Builds string-encoded signed lines for each leg.
    function _buildLines(address ticketAddr, uint legsLen) internal view returns (string[] memory out) {
        Ticket t = Ticket(ticketAddr);
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            (, , , , , int24 line, , , ) = t.markets(i);
            out[i] = _intToString(int256(line));
        }
    }

    /// @dev Builds decimal-encoded expected odds per leg.
    function _buildExpectedOdds(
        uint[] calldata expectedOddsPerLeg,
        uint legsLen
    ) internal pure returns (string[] memory out) {
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            out[i] = Strings.toString(expectedOddsPerLeg[i]);
        }
    }

    /// @dev Builds "1"/"0" strings representing resolved flags.
    function _buildIsResolved(bool[] calldata isLegResolved, uint legsLen) internal pure returns (string[] memory out) {
        out = new string[](legsLen);
        for (uint i = 0; i < legsLen; ++i) {
            out[i] = isLegResolved[i] ? "1" : "0";
        }
    }

    /// @dev Converts a signed integer to string (base-10), including a leading '-' for negative values.
    function _intToString(int256 value) internal pure returns (string memory) {
        if (value >= 0) return Strings.toString(uint256(value));
        return string(abi.encodePacked("-", Strings.toString(uint256(-value))));
    }

    // ============================
    // Admin
    // ============================

    /**
     * @notice Pauses/unpauses {requestCashout} and {fulfillCashout}.
     * @param _setPausing True to pause, false to unpause.
     */
    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /**
     * @notice Updates Chainlink + SportsAMM configuration in a single call.
     * @dev Emits {ContextReset}.
     * @param _link New LINK token address.
     * @param _oracle New oracle address.
     * @param _sportsAMM New SportsAMM address.
     * @param _jobSpecId New job spec id.
     * @param _paymentAmount New payment amount.
     */
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

    /**
     * @notice Sets the maximum oracle execution delay (staleness limit) for fulfillments.
     * @param _maxAllowedExecutionDelay Delay in seconds.
     */
    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    /**
     * @notice Sets the FreeBetsHolder address; tickets owned by this address are not cashoutable.
     * @param _freeBetsHolder FreeBetsHolder address (set to zero to disable this restriction).
     */
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    // ============================
    // View helpers (reverted back in)
    // ============================

    /**
     * @notice Returns basic request info for UI/indexers.
     * @param requestId Chainlink request id.
     * @return ticket Ticket address.
     * @return requester Requester address.
     * @return additionalSlippage Additional slippage set by requester.
     * @return ts Timestamp (block.timestamp) when the request was stored.
     * @return fulfilled Whether it has been fulfilled.
     * @return allow Whether the oracle allowed the cashout (only meaningful if fulfilled).
     */
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

    /**
     * @notice Returns per-leg arrays associated with a request for UI/debugging.
     * @param requestId Chainlink request id.
     * @return expectedOddsPerLeg User-provided expected odds per leg.
     * @return isLegResolved User-provided resolved flags per leg.
     * @return approvedOddsPerLeg Oracle-approved odds per leg (empty until fulfilled).
     */
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
    // Events
    // ============================

    /// @notice Emitted when Chainlink/SportsAMM context is updated.
    event ContextReset(address link, address oracle, address sportsAMM, bytes32 jobSpecId, uint paymentAmount);

    /// @notice Emitted when a cashout request is created.
    event CashoutRequested(
        address indexed requester,
        uint indexed requestCounter,
        bytes32 indexed requestId,
        address ticket,
        uint legs,
        uint additionalSlippage
    );

    /// @notice Emitted when a request is fulfilled (will only be emitted if allow=true and cashout executes).
    event CashoutFulfilled(
        address indexed requester,
        bytes32 indexed requestId,
        address ticket,
        bool allow,
        uint legs,
        uint timestamp
    );

    /// @notice Emitted when maxAllowedExecutionDelay is updated.
    event SetMaxAllowedExecutionDelay(uint delay);

    /// @notice Emitted when freeBetsHolder is updated.
    event SetFreeBetsHolder(address _freeBetsHolder);
}
