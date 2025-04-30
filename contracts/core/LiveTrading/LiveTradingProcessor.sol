// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/IStakingThalesBettingProxy.sol";

contract LiveTradingProcessor is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;
    using SafeERC20 for IERC20;

    uint private constant ONE = 1e18;

    ISportsAMMV2 public sportsAMM;

    address freeBetsHolder;

    bytes32 public jobSpecId;

    uint public paymentAmount;

    uint public maxAllowedExecutionDelay = 60;

    mapping(bytes32 => ILiveTradingProcessor.LiveTradeData) public requestIdToTradeData;
    mapping(bytes32 => address) public requestIdToRequester;
    mapping(bytes32 => bool) public requestIdToFulfillAllowed;
    mapping(bytes32 => bool) public requestIdFulfilled;
    mapping(bytes32 => uint) public timestampPerRequest;

    uint public requestCounter;
    mapping(uint => bytes32) public counterToRequestId;

    address public stakingThalesBettingProxy;

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

    /// @notice requestLiveTrade
    /// @param _liveTradeData for which to request a live trade
    function requestLiveTrade(
        ILiveTradingProcessor.LiveTradeData calldata _liveTradeData
    ) external whenNotPaused returns (bytes32 requestId) {
        require(
            sportsAMM.riskManager().liveTradingPerSportAndTypeEnabled(_liveTradeData._sportId, _liveTradeData._typeId),
            "Live trading not enabled on _sportId"
        );

        Chainlink.Request memory req;

        req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillLiveTrade.selector);

        req.add("gameId", _liveTradeData._gameId);
        req.addUint("sportId", _liveTradeData._sportId);
        req.addUint("typeId", _liveTradeData._typeId);
        req.addInt("line", _liveTradeData._line);
        req.addUint("position", _liveTradeData._position);
        req.addUint("buyInAmount", _liveTradeData._buyInAmount);
        req.addUint("expectedQuote", _liveTradeData._expectedQuote);
        req.addUint("additionalSlippage", _liveTradeData._additionalSlippage);

        requestId = sendChainlinkRequest(req, paymentAmount);
        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTradeData[requestId] = _liveTradeData;
        requestIdToRequester[requestId] = msg.sender;

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

    /// @notice fulfillLiveTrade
    /// @param _requestId which is being fulfilled
    /// @param _allow whether the live trade should go through
    /// @param _approvedQuote what will be the actual payout
    function fulfillLiveTrade(
        bytes32 _requestId,
        bool _allow,
        uint _approvedQuote
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        //might be redundant as already done by Chainlink Client, but making double sure
        require(!requestIdFulfilled[_requestId], "Request ID already fulfilled");
        require((timestampPerRequest[_requestId] + maxAllowedExecutionDelay) > block.timestamp, "Request timed out");

        ILiveTradingProcessor.LiveTradeData memory lTradeData = requestIdToTradeData[_requestId];
        address requester = requestIdToRequester[_requestId];

        require(
            ((ONE * _approvedQuote) / lTradeData._expectedQuote) <= (ONE + lTradeData._additionalSlippage),
            "Slippage too high"
        );

        if (_allow) {
            ISportsAMMV2.TradeData[] memory tradeData = new ISportsAMMV2.TradeData[](1);
            bytes32[] memory merkleProofs;
            uint[] memory odds = new uint[](26);
            odds[lTradeData._position] = _approvedQuote;
            ISportsAMMV2.CombinedPosition[][] memory comPositions = new ISportsAMMV2.CombinedPosition[][](26);

            tradeData[0] = ISportsAMMV2.TradeData(
                stringToBytes32(lTradeData._gameId),
                lTradeData._sportId,
                lTradeData._typeId, //type
                block.timestamp + 60, //maturity, hardcode to timestamp with buffer
                0, //status
                lTradeData._line, //line
                0, //playerId
                odds, //odds[]
                merkleProofs, //merkleProof[]
                lTradeData._position,
                comPositions //combinedPositions[]
            );

            if (requester == stakingThalesBettingProxy) {
                IStakingThalesBettingProxy(stakingThalesBettingProxy).preConfirmLiveTrade(
                    _requestId,
                    lTradeData._buyInAmount
                );
            }

            address _createdTicket = sportsAMM.tradeLive(
                tradeData,
                lTradeData._buyInAmount,
                _approvedQuote,
                requester,
                lTradeData._referrer,
                lTradeData._collateral
            );

            if (requester == freeBetsHolder) {
                IFreeBetsHolder(freeBetsHolder).confirmLiveTrade(
                    _requestId,
                    _createdTicket,
                    lTradeData._buyInAmount,
                    lTradeData._collateral
                );
            } else if (requester == stakingThalesBettingProxy) {
                IStakingThalesBettingProxy(stakingThalesBettingProxy).confirmLiveTrade(
                    _requestId,
                    _createdTicket,
                    lTradeData._buyInAmount
                );
            }
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

    /// @notice withdraw collateral in the contract
    /// @param collateral the collateral address
    /// @param recipient the recipient of the collateral
    function withdrawCollateral(address collateral, address recipient) external onlyOwner {
        IERC20(collateral).safeTransfer(recipient, IERC20(collateral).balanceOf(address(this)));
    }

    //////////// SETTERS

    /// @notice pause live trading
    /// @param _setPausing whether to pause or unpause
    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /// @notice setConfiguration
    /// @param _link paymentAmount token
    /// @param _oracle CL node that will execute the requests
    /// @param _sportsAMM address
    /// @param _jobSpecId CL node job spec ID
    /// @param _paymentAmount amount of paymentAmount token for each request
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

    /// @notice sets the FreeBetsHolder address, required for handling ticket claiming via FreeBetsHolder
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    /// @notice sets the stakingThalesBettingProxy address, required for handling ticket claiming via StakingThalesBettingProxy
    function setStakingThalesBettingProxy(address _stakingThalesBettingProxy) external onlyOwner {
        stakingThalesBettingProxy = _stakingThalesBettingProxy;
        emit SetStakingThalesBettingProxy(_stakingThalesBettingProxy);
    }

    /// @notice setMaxAllowedExecutionDelay
    /// @param _maxAllowedExecutionDelay maximum allowed buffer for the CL request to be executed, defaulted at 60 seconds
    function setMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay) external onlyOwner {
        maxAllowedExecutionDelay = _maxAllowedExecutionDelay;
        emit SetMaxAllowedExecutionDelay(_maxAllowedExecutionDelay);
    }

    //// GETTERS

    /// @notice gets trade data struct for specified request ID
    /// @param requestId request ID
    /// @return liveTradeData
    function getTradeData(bytes32 requestId) external view returns (ILiveTradingProcessor.LiveTradeData memory) {
        return requestIdToTradeData[requestId];
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

    /////// EVENTS
    event ContextReset(address _link, address _oracle, address _sportsAMM, bytes32 _jobSpecId, uint _paymentAmount);
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
    event SetMaxAllowedExecutionDelay(uint _maxAllowedExecutionDelay);
    event SetFreeBetsHolder(address _freeBetsHolder);
    event SetStakingThalesBettingProxy(address _stakingThalesBettingProxy);
}
