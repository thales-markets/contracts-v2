// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "../../interfaces/ILiveTradingProcessor.sol";

contract LiveTradingProcessor is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;
    using SafeERC20 for IERC20;

    uint private constant ONE = 1e18;
    uint private constant ODDS_LEN = 225;

    ISportsAMMV2 public sportsAMM;

    address public freeBetsHolder;

    bytes32 public jobSpecId; // single job
    uint public paymentAmount;

    bytes32 public parlayJobSpecId; // parlay job

    uint public maxAllowedExecutionDelay = 60;

    // ===== Singles =====
    mapping(bytes32 => ILiveTradingProcessor.LiveTradeData) public requestIdToTradeData;

    // ===== Parlays =====
    mapping(bytes32 => ILiveTradingProcessor.LiveParlayTradeData) public requestIdToParlayTradeData;
    mapping(bytes32 => bool) public requestIdIsParlay;

    // ===== Common =====
    mapping(bytes32 => address) public requestIdToRequester;
    mapping(bytes32 => bool) public requestIdToFulfillAllowed;
    mapping(bytes32 => bool) public requestIdFulfilled;
    mapping(bytes32 => uint) public timestampPerRequest;

    uint public requestCounter;
    mapping(uint => bytes32) public counterToRequestId;

    mapping(bytes32 => address) public requestIdToTicketId;

    /// @notice Constructor for LiveTradingProcessor.
    /// @dev Sets Chainlink token/oracle, SportsAMM reference, job specs and payment amount.
    /// @param _link LINK token address used for Chainlink payments
    /// @param _oracle Chainlink oracle address
    /// @param _sportsAMM SportsAMMV2 contract address
    /// @param _jobSpecId Job spec id for SINGLE live verification requests
    /// @param _parlayJobSpecId Job spec id for PARLAY live verification requests
    /// @param _paymentAmount LINK payment amount per request
    constructor(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        bytes32 _parlayJobSpecId,
        uint _paymentAmount
    ) Ownable(msg.sender) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        sportsAMM = ISportsAMMV2(_sportsAMM);

        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;

        parlayJobSpecId = _parlayJobSpecId;
    }

    /// @notice requestLiveTrade (SINGLE)
    /// @dev Sends a Chainlink request for live trade verification for a single market.
    ///      Stores request metadata for later fulfillment and emits LiveTradeRequested.
    /// @param _liveTradeData LiveTradeData describing the trade to be verified/executed
    /// @return requestId Chainlink request id
    function requestLiveTrade(
        ILiveTradingProcessor.LiveTradeData calldata _liveTradeData
    ) external whenNotPaused returns (bytes32 requestId) {
        require(
            sportsAMM.riskManager().liveTradingPerSportAndTypeEnabled(_liveTradeData._sportId, _liveTradeData._typeId),
            "Live trading not enabled on _sportId"
        );

        require(_liveTradeData._expectedQuote >= sportsAMM.riskManager().maxSupportedOdds(), "ExceededMaxOdds");

        Chainlink.Request memory req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillLiveTrade.selector);

        req.add("mode", "single");

        req.add("gameId", _liveTradeData._gameId);
        req.addUint("sportId", _liveTradeData._sportId);
        req.addUint("typeId", _liveTradeData._typeId);
        req.addInt("line", _liveTradeData._line);
        req.addUint("position", _liveTradeData._position);
        req.addUint("buyInAmount", _liveTradeData._buyInAmount);
        req.addUint("expectedQuote", _liveTradeData._expectedQuote);
        req.addUint("additionalSlippage", _liveTradeData._additionalSlippage);
        req.addUint("playerId", _liveTradeData._playerId);

        // requester & collateral included for adapter-side logging/validation
        req.add("requester", Strings.toHexString(msg.sender));
        req.add("collateral", Strings.toHexString(_liveTradeData._collateral));

        requestId = sendChainlinkRequest(req, paymentAmount);

        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTradeData[requestId] = _liveTradeData;
        requestIdToRequester[requestId] = msg.sender;
        requestIdIsParlay[requestId] = false;

        counterToRequestId[requestCounter] = requestId;

        emit LiveTradeRequested(
            msg.sender,
            requestCounter,
            requestId,
            stringToBytes32(_liveTradeData._gameId),
            _liveTradeData._sportId,
            _liveTradeData._typeId,
            _liveTradeData._line,
            _liveTradeData._position,
            _liveTradeData._buyInAmount,
            _liveTradeData._expectedQuote,
            _liveTradeData._collateral
        );
        requestCounter++;
    }

    /// @notice requestLiveParlayTrade (PARLAY)
    /// @dev Sends a Chainlink request for live trade verification for a parlay (multi-leg) trade.
    ///      Validates that:
    ///        - parlay has > 1 leg
    ///        - live trading is enabled for each leg's (sportId, typeId)
    ///      Stores request metadata for later fulfillment and emits LiveParlayTradeRequested.
    /// @param _parlay LiveParlayTradeData describing the parlay to be verified/executed
    /// @return requestId Chainlink request id
    function requestLiveParlayTrade(
        ILiveTradingProcessor.LiveParlayTradeData calldata _parlay
    ) external whenNotPaused returns (bytes32 requestId) {
        uint legsLen = _parlay.legs.length;
        require(legsLen > 1, "Parlay must have > 1 leg");

        for (uint i = 0; i < legsLen; ++i) {
            ILiveTradingProcessor.LiveParlayLeg calldata leg = _parlay.legs[i];
            require(
                sportsAMM.riskManager().liveTradingPerSportAndTypeEnabled(leg.sportId, leg.typeId),
                "Live trading not enabled on leg"
            );
        }

        require(_parlay.expectedPayout >= sportsAMM.riskManager().maxSupportedOdds(), "ExceededMaxOdds");

        Chainlink.Request memory req = buildChainlinkRequest(
            parlayJobSpecId,
            address(this),
            this.fulfillLiveTradeParlay.selector
        );

        req.add("mode", "parlay");

        // Chainlink request payload: arrays are provided as string arrays to be adapter-friendly.
        string[] memory gameIds = new string[](legsLen);
        string[] memory sportIds = new string[](legsLen);
        string[] memory typeIds = new string[](legsLen);
        string[] memory lines = new string[](legsLen);
        string[] memory positions = new string[](legsLen);
        string[] memory expectedLegOdds = new string[](legsLen);
        string[] memory playerIds = new string[](legsLen);

        for (uint i = 0; i < legsLen; ++i) {
            ILiveTradingProcessor.LiveParlayLeg calldata leg = _parlay.legs[i];
            gameIds[i] = leg.gameId;
            sportIds[i] = Strings.toString(uint256(leg.sportId));
            typeIds[i] = Strings.toString(uint256(leg.typeId));
            lines[i] = _intToString(int256(leg.line));
            positions[i] = Strings.toString(uint256(leg.position));
            expectedLegOdds[i] = Strings.toString(uint256(leg.expectedLegOdd));
            playerIds[i] = Strings.toString(uint256(leg.playerId));
        }

        req.addStringArray("gameIds", gameIds);
        req.addStringArray("sportIds", sportIds);
        req.addStringArray("typeIds", typeIds);
        req.addStringArray("lines", lines);
        req.addStringArray("positions", positions);
        req.addStringArray("expectedLegOdds", expectedLegOdds);
        req.addStringArray("playerIds", playerIds);

        req.addUint("buyInAmount", _parlay.buyInAmount);
        req.addUint("expectedQuote", _parlay.expectedPayout);
        req.addUint("additionalSlippage", _parlay.additionalSlippage);

        req.add("requester", Strings.toHexString(msg.sender));
        req.add("collateral", Strings.toHexString(_parlay.collateral));

        requestId = sendChainlinkRequest(req, paymentAmount);

        timestampPerRequest[requestId] = block.timestamp;
        requestIdToParlayTradeData[requestId] = _parlay;
        requestIdToRequester[requestId] = msg.sender;
        requestIdIsParlay[requestId] = true;

        counterToRequestId[requestCounter] = requestId;

        emit LiveParlayTradeRequested(msg.sender, requestCounter, requestId, uint16(legsLen), _parlay.buyInAmount);
        requestCounter++;
    }

    // ============================
    // Fulfill methods
    // ============================

    /// @notice fulfillLiveTrade (SINGLE)
    /// @dev Chainlink callback for single live trade verification.
    ///      Requirements:
    ///        - request not already fulfilled
    ///        - request not timed out (timestampPerRequest + maxAllowedExecutionDelay)
    ///        - request must not be a parlay
    ///        - slippage constraint satisfied
    ///      If `_allow` is true, executes `sportsAMM.tradeLive(...)` for a single TradeData entry.
    /// @param _requestId Chainlink request id being fulfilled
    /// @param _allow Whether the trade is allowed after verification
    /// @param _approvedQuote Approved quote (odds) for the selected position
    function fulfillLiveTrade(
        bytes32 _requestId,
        bool _allow,
        uint _approvedQuote
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        require(!requestIdFulfilled[_requestId], "Request ID already fulfilled");
        require((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) > block.timestamp, "Request timed out");
        require(!requestIdIsParlay[_requestId], "Request is parlay");

        ILiveTradingProcessor.LiveTradeData memory lTradeData = requestIdToTradeData[_requestId];
        address requester = requestIdToRequester[_requestId];

        // Ensure approved quote respects additional slippage bound relative to expected quote.
        require(
            ((ONE * _approvedQuote) / lTradeData._expectedQuote) <= (ONE + lTradeData._additionalSlippage),
            "Slippage too high"
        );

        if (_allow) {
            ISportsAMMV2.TradeData[] memory tradeData = new ISportsAMMV2.TradeData[](1);
            tradeData[0] = _buildTradeDataSingle(lTradeData, _approvedQuote);

            _executeTrade(
                _requestId,
                requester,
                tradeData,
                lTradeData._buyInAmount,
                _approvedQuote,
                lTradeData._referrer,
                lTradeData._collateral
            );
        }

        requestIdToFulfillAllowed[_requestId] = _allow;
        requestIdFulfilled[_requestId] = true;

        emit LiveTradeFulfilled(
            requester,
            _requestId,
            _allow,
            stringToBytes32(lTradeData._gameId),
            lTradeData._sportId,
            lTradeData._typeId,
            lTradeData._line,
            lTradeData._position,
            lTradeData._buyInAmount,
            _approvedQuote,
            lTradeData._collateral,
            block.timestamp
        );
    }

    /// @notice fulfillLiveTradeParlay (PARLAY)
    /// @dev Chainlink callback for parlay live trade verification.
    ///      Requirements:
    ///        - request not already fulfilled
    ///        - request not timed out (timestampPerRequest + maxAllowedExecutionDelay)
    ///        - request must be a parlay
    ///        - legsLen > 1 and approvedLegOdds length must match legsLen
    ///        - slippage constraint satisfied vs expectedPayout
    ///      If `_allow` is true, executes `sportsAMM.tradeLive(...)` for TradeData[] of length legsLen.
    /// @param _requestId Chainlink request id being fulfilled
    /// @param _allow Whether the trade is allowed after verification
    /// @param _approvedQuote Approved quote for the overall parlay payout
    /// @param _approvedLegOdds Approved odds per leg (must match legs length)
    function fulfillLiveTradeParlay(
        bytes32 _requestId,
        bool _allow,
        uint _approvedQuote,
        uint[] calldata _approvedLegOdds
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        require(!requestIdFulfilled[_requestId], "Request ID already fulfilled");
        require((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) > block.timestamp, "Request timed out");
        require(requestIdIsParlay[_requestId], "Request is not parlay");

        ILiveTradingProcessor.LiveParlayTradeData memory pTrade = requestIdToParlayTradeData[_requestId];
        address requester = requestIdToRequester[_requestId];
        uint legsLen = pTrade.legs.length;

        require(legsLen > 1, "Parlay must have > 1 leg");
        require(_approvedLegOdds.length == legsLen, "Bad leg odds length");

        // Ensure approved quote respects additional slippage bound relative to expected payout.
        require(((ONE * _approvedQuote) / pTrade.expectedPayout) <= (ONE + pTrade.additionalSlippage), "Slippage too high");

        if (_allow) {
            ISportsAMMV2.TradeData[] memory tradeData = new ISportsAMMV2.TradeData[](legsLen);
            for (uint i = 0; i < legsLen; ++i) {
                tradeData[i] = _buildTradeDataParlayLeg(pTrade.legs[i], _approvedLegOdds[i]);
            }

            _executeTrade(
                _requestId,
                requester,
                tradeData,
                pTrade.buyInAmount,
                _approvedQuote,
                pTrade.referrer,
                pTrade.collateral
            );
        }

        requestIdToFulfillAllowed[_requestId] = _allow;
        requestIdFulfilled[_requestId] = true;

        emit LiveParlayTradeFulfilled(requester, _requestId, _allow, uint16(legsLen), pTrade.buyInAmount, _approvedQuote);
    }

    // ============================
    // Internal helpers
    // ============================

    /// @notice Executes a verified live trade via SportsAMM and performs post-trade confirmation if required.
    /// @dev Stores the created ticket address for the request id and optionally confirms via FreeBetsHolder.
    /// @param _requestId Chainlink request id associated with the trade
    /// @param requester Original requester that initiated the trade request
    /// @param tradeData TradeData array to pass to SportsAMMV2.tradeLive (len=1 for singles, len>1 for parlays)
    /// @param buyInAmount Buy-in amount for the trade
    /// @param approvedQuote Approved quote (overall payout) returned by the verifier
    /// @param referrer Referrer address (if any)
    /// @param collateral Collateral token used for the trade
    function _executeTrade(
        bytes32 _requestId,
        address requester,
        ISportsAMMV2.TradeData[] memory tradeData,
        uint buyInAmount,
        uint approvedQuote,
        address referrer,
        address collateral
    ) internal {
        address _createdTicket = sportsAMM.tradeLive(tradeData, buyInAmount, approvedQuote, requester, referrer, collateral);
        requestIdToTicketId[_requestId] = _createdTicket;

        if (requester == freeBetsHolder) {
            IFreeBetsHolder(freeBetsHolder).confirmLiveTrade(_requestId, _createdTicket, buyInAmount, collateral);
        }
    }

    /// @notice Builds TradeData for a single-leg live trade.
    /// @dev Creates ODDS_LEN-sized odds array with only selected position set to approvedLegOdd.
    /// @param lTradeData Original live trade data requested by the user
    /// @param approvedLegOdd Approved odd for the selected position
    /// @return td TradeData struct to be passed to SportsAMMV2.tradeLive
    function _buildTradeDataSingle(
        ILiveTradingProcessor.LiveTradeData memory lTradeData,
        uint approvedLegOdd
    ) internal view returns (ISportsAMMV2.TradeData memory td) {
        bytes32[] memory merkleProofs;

        uint[] memory odds = new uint[](ODDS_LEN);
        odds[lTradeData._position] = approvedLegOdd;

        ISportsAMMV2.CombinedPosition[][] memory comPositions = new ISportsAMMV2.CombinedPosition[][](ODDS_LEN);

        td = ISportsAMMV2.TradeData(
            stringToBytes32(lTradeData._gameId),
            lTradeData._sportId,
            lTradeData._typeId,
            block.timestamp + 60,
            0,
            lTradeData._line,
            lTradeData._playerId,
            odds,
            merkleProofs,
            lTradeData._position,
            comPositions
        );
    }

    /// @notice Builds TradeData for a single parlay leg.
    /// @dev Creates ODDS_LEN-sized odds array with only leg.position set to approvedLegOdd.
    /// @param leg Parlay leg parameters
    /// @param approvedLegOdd Approved odd for this specific leg/position
    /// @return td TradeData struct to be passed to SportsAMMV2.tradeLive
    function _buildTradeDataParlayLeg(
        ILiveTradingProcessor.LiveParlayLeg memory leg,
        uint approvedLegOdd
    ) internal view returns (ISportsAMMV2.TradeData memory td) {
        bytes32[] memory merkleProofs;

        uint[] memory odds = new uint[](ODDS_LEN);
        odds[leg.position] = approvedLegOdd;

        ISportsAMMV2.CombinedPosition[][] memory comPositions = new ISportsAMMV2.CombinedPosition[][](ODDS_LEN);

        td = ISportsAMMV2.TradeData(
            stringToBytes32(leg.gameId),
            leg.sportId,
            leg.typeId,
            block.timestamp + 60,
            0,
            leg.line,
            leg.playerId,
            odds,
            merkleProofs,
            leg.position,
            comPositions
        );
    }

    /// @notice withdraw collateral in the contract
    /// @dev Transfers the full balance of `collateral` held by this contract to `recipient`.
    /// @param collateral ERC20 token address to withdraw
    /// @param recipient Address receiving withdrawn collateral
    function withdrawCollateral(address collateral, address recipient) external onlyOwner {
        IERC20(collateral).safeTransfer(recipient, IERC20(collateral).balanceOf(address(this)));
    }

    //////////// SETTERS

    /// @notice pause live trading
    /// @dev Pauses or unpauses contract functions protected by whenNotPaused.
    /// @param _setPausing whether to pause or unpause
    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /// @notice Configuration setter
    /// @dev Updates Chainlink and SportsAMM configuration, including both single and parlay job spec ids.
    /// @param _link LINK token address used for Chainlink payments
    /// @param _oracle Chainlink oracle address
    /// @param _sportsAMM SportsAMMV2 contract address
    /// @param _jobSpecId Job spec id for SINGLE live verification requests
    /// @param _parlayJobSpecId Job spec id for PARLAY live verification requests
    /// @param _paymentAmount LINK payment amount per request
    function setConfiguration(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        bytes32 _parlayJobSpecId,
        uint _paymentAmount
    ) external onlyOwner {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        sportsAMM = ISportsAMMV2(_sportsAMM);

        jobSpecId = _jobSpecId;
        parlayJobSpecId = _parlayJobSpecId;
        paymentAmount = _paymentAmount;

        emit ContextReset(_link, _oracle, _sportsAMM, _jobSpecId, _parlayJobSpecId, _paymentAmount);
    }

    /// @notice sets the FreeBetsHolder address, required for handling ticket claiming via FreeBetsHolder
    /// @param _freeBetsHolder FreeBetsHolder contract address
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    /// @notice setMaxAllowedExecutionDelay
    /// @dev Sets maximum allowed buffer for the Chainlink request to be executed.
    /// @param _maxAllowedExecutionDelay maximum allowed buffer in seconds
    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    //// GETTERS

    /// @notice gets trade data struct for specified request ID (singles)
    /// @param requestId request ID
    /// @return liveTradeData Stored LiveTradeData for requestId
    function getTradeData(bytes32 requestId) external view returns (ILiveTradingProcessor.LiveTradeData memory) {
        return requestIdToTradeData[requestId];
    }

    /// @notice gets parlay trade data struct for specified request ID (parlays)
    /// @param requestId request ID
    /// @return parlayTradeData Stored LiveParlayTradeData for requestId
    function getParlayTradeData(bytes32 requestId) external view returns (ILiveTradingProcessor.LiveParlayTradeData memory) {
        return requestIdToParlayTradeData[requestId];
    }

    //// UTILITY

    /// @notice Converts a string into bytes32 by taking the first 32 bytes.
    /// @dev Returns 0x0 for empty strings. Used for gameId conversions.
    function stringToBytes32(string memory source) internal pure returns (bytes32 result) {
        bytes memory tempEmptyStringTest = bytes(source);
        if (tempEmptyStringTest.length == 0) {
            return 0x0;
        }
        assembly {
            result := mload(add(source, 32))
        }
    }

    /// @notice Converts signed integer into string representation.
    /// @dev Used for encoding negative lines in Chainlink request arrays.
    function _intToString(int256 value) internal pure returns (string memory) {
        if (value >= 0) {
            return Strings.toString(uint256(value));
        }
        return string(abi.encodePacked("-", Strings.toString(uint256(-value))));
    }

    /////// EVENTS

    event ContextReset(
        address _link,
        address _oracle,
        address _sportsAMM,
        bytes32 _jobSpecId,
        bytes32 _parlayJobSpecId,
        uint _paymentAmount
    );

    event LiveTradeRequested(
        address requester,
        uint requestCounter,
        bytes32 requestId,
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        int24 _line,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedQuote,
        address _collateral
    );

    event LiveTradeFulfilled(
        address requester,
        bytes32 requestId,
        bool _allow,
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        int24 _line,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedQuote,
        address _collateral,
        uint timestamp
    );

    event LiveParlayTradeRequested(
        address requester,
        uint requestCounter,
        bytes32 requestId,
        uint16 legsCount,
        uint buyInAmount
    );

    event LiveParlayTradeFulfilled(
        address requester,
        bytes32 requestId,
        bool _allow,
        uint16 legsCount,
        uint buyInAmount,
        uint approvedQuote
    );

    event SetMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay);
    event SetFreeBetsHolder(address _freeBetsHolder);
}
