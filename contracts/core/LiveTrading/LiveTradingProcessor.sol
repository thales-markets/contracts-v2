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

    // ===== Singles (BACKWARDS COMPAT) =====
    bytes32 public jobSpecId; // single job
    uint public paymentAmount;

    // ===== Parlays (NEW) =====
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

    /// @notice requestLiveTrade (SINGLE) - unchanged signature
    function requestLiveTrade(
        ILiveTradingProcessor.LiveTradeData calldata _liveTradeData
    ) external whenNotPaused returns (bytes32 requestId) {
        require(
            sportsAMM.riskManager().liveTradingPerSportAndTypeEnabled(_liveTradeData._sportId, _liveTradeData._typeId),
            "Live trading not enabled on _sportId"
        );

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

        Chainlink.Request memory req = buildChainlinkRequest(
            parlayJobSpecId,
            address(this),
            this.fulfillLiveTradeParlay.selector
        );

        req.add("mode", "parlay");

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

    /// @notice fulfillLiveTrade - BACKWARDS COMPAT (singles only)
    /// @dev Keep EXACT signature of production version
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

    /// @notice fulfillLiveTradeParlay - NEW (parlays)
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
    function withdrawCollateral(address collateral, address recipient) external onlyOwner {
        IERC20(collateral).safeTransfer(recipient, IERC20(collateral).balanceOf(address(this)));
    }

    //////////// SETTERS

    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /// @notice Backwards-compatible setter + parlay config added
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

    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    //// GETTERS

    function getTradeData(bytes32 requestId) external view returns (ILiveTradingProcessor.LiveTradeData memory) {
        return requestIdToTradeData[requestId];
    }

    function getParlayTradeData(bytes32 requestId) external view returns (ILiveTradingProcessor.LiveParlayTradeData memory) {
        return requestIdToParlayTradeData[requestId];
    }

    //// UTILITY

    function stringToBytes32(string memory source) internal pure returns (bytes32 result) {
        bytes memory tempEmptyStringTest = bytes(source);
        if (tempEmptyStringTest.length == 0) {
            return 0x0;
        }
        assembly {
            result := mload(add(source, 32))
        }
    }

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
