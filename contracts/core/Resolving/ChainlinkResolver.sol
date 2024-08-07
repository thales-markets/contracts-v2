// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";

contract ChainlinkResolver is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;
    using SafeERC20 for IERC20;

    uint private constant ONE = 1e18;

    ISportsAMMV2 public sportsAMM;
    ISportsAMMV2ResultManager public resultManager;

    bytes32 public jobSpecId;

    uint public paymentAmount;

    IERC20 public linkToken;

    mapping(bytes32 => bool) public requestIdFulfilled;

    struct MarketResolveData {
        bytes32 requestId;
        string[] _gameIds;
        string[] _typeIds;
        string[] _playerIds;
    }

    mapping(bytes32 => MarketResolveData) public requestIdToMarketResolveData;

    uint public requestCounter;
    mapping(uint => bytes32) public counterToRequestId;

    constructor(
        address _link,
        address _oracle,
        address _sportsAMM,
        address _resultManager,
        bytes32 _jobSpecId,
        uint _paymentAmount
    ) Ownable(msg.sender) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        linkToken = IERC20(_link);
        sportsAMM = ISportsAMMV2(_sportsAMM);
        resultManager = ISportsAMMV2ResultManager(_resultManager);
        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;
    }

    /// @notice requestMarketResolving
    /// @param _sportId sports id
    /// @param _date date on which game/games are played
    /// @param _gameIds for which to request resolving
    /// @param _typeIds for which to request resolving
    /// @param _playerIds for which to request resolving
    function requestMarketResolving(
        uint256 _sportId,
        uint256 _date,
        string[] calldata _gameIds,
        string[] calldata _typeIds,
        string[] calldata _playerIds
    ) external whenNotPaused {
        require(
            _gameIds.length > 0 && _gameIds.length == _typeIds.length && _typeIds.length == _playerIds.length,
            "Requested data has to be of same length"
        );
        Chainlink.Request memory req;

        req = buildChainlinkRequest(jobSpecId, address(this), this.fulfillMarketResolve.selector);

        req.addUint("date", _date);
        req.addUint("sportId", _sportId);
        req.addStringArray("gameIds", _gameIds);
        req.addStringArray("typeIds", _typeIds);
        req.addStringArray("playerIds", _playerIds);

        _putLink(msg.sender, paymentAmount);

        bytes32 requestId = sendChainlinkRequest(req, paymentAmount);

        MarketResolveData memory data = MarketResolveData(requestId, _gameIds, _typeIds, _playerIds);
        requestIdToMarketResolveData[requestId] = data;

        counterToRequestId[requestCounter++] = requestId;

        emit MarketResolvingRequested(msg.sender, _gameIds, _typeIds, _playerIds);
    }

    /// @notice fulfillMarketResolve
    /// @param _requestId which is being responded to
    /// @param _results to use for resolving
    function fulfillMarketResolve(
        bytes32 _requestId,
        int24[][] calldata _results
    ) external whenNotPaused recordChainlinkFulfillment(_requestId) {
        //might be redundant as already done by Chainlink Client, but making double sure
        require(!requestIdFulfilled[_requestId], "Request ID already fulfilled");

        MarketResolveData memory marketData = requestIdToMarketResolveData[_requestId];

        bytes32[] memory _gameIds = new bytes32[](marketData._gameIds.length);
        uint16[] memory _typeIds = new uint16[](marketData._typeIds.length);
        uint24[] memory _playerIds = new uint24[](marketData._playerIds.length);

        require(_results.length == _gameIds.length, "Results not of same length as requested");

        for (uint i = 0; i < marketData._gameIds.length; i++) {
            _gameIds[i] = stringToBytes32(marketData._gameIds[i]);
            _typeIds[i] = uint16(st2num(marketData._typeIds[i]));
            _playerIds[i] = uint24(st2num(marketData._playerIds[i]));
        }

        resultManager.setResultsPerMarkets(_gameIds, _typeIds, _playerIds, _results);

        requestIdFulfilled[_requestId] = true;

        emit FulfillMarketResolveCall(_requestId, marketData._gameIds, marketData._typeIds, marketData._playerIds, _results);
    }

    /* ========== INTERNALS ========== */

    function _putLink(address _sender, uint _payment) internal {
        linkToken.safeTransferFrom(_sender, address(this), _payment);
    }

    function stringToBytes32(string memory source) internal pure returns (bytes32 result) {
        bytes memory tempEmptyStringTest = bytes(source);
        if (tempEmptyStringTest.length == 0) {
            return 0x0;
        }
        assembly {
            result := mload(add(source, 32))
        }
    }

    function st2num(string memory numString) internal pure returns (uint) {
        uint val = 0;
        bytes memory stringBytes = bytes(numString);
        for (uint i = 0; i < stringBytes.length; i++) {
            uint exp = stringBytes.length - i;
            bytes1 ival = stringBytes[i];
            uint8 uval = uint8(ival);
            uint jval = uval - uint(0x30);
            val += (uint(jval) * (10 ** (exp - 1)));
        }
        return val;
    }

    //////////// SETTERS

    /// @notice pause resolving
    /// @param _setPausing whether to pause or unpause
    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /// @notice setConfiguration
    /// @param _link paymentAmount token
    /// @param _oracle CL node that will execute the requests
    /// @param _sportsAMM address
    /// @param _resultManager address
    /// @param _jobSpecId CL node job spec ID
    /// @param _paymentAmount amount of paymentAmount token for each request
    function setConfiguration(
        address _link,
        address _oracle,
        address _sportsAMM,
        address _resultManager,
        bytes32 _jobSpecId,
        uint _paymentAmount
    ) external onlyOwner {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        linkToken = IERC20(_link);
        sportsAMM = ISportsAMMV2(_sportsAMM);
        resultManager = ISportsAMMV2ResultManager(_resultManager);
        jobSpecId = _jobSpecId;
        paymentAmount = _paymentAmount;

        emit ContextReset(_link, _oracle, _sportsAMM, _resultManager, _jobSpecId, _paymentAmount);
    }

    /////// EVENTS
    event ContextReset(
        address _link,
        address _oracle,
        address _sportsAMM,
        address _resultManager,
        bytes32 _jobSpecId,
        uint _paymentAmount
    );
    event MarketResolvingRequested(address requester, string[] _gameIds, string[] _typeIds, string[] _playerIds);
    event FulfillMarketResolveCall(
        bytes32 requestId,
        string[] _gameIds,
        string[] _typeIds,
        string[] _playerIds,
        int24[][] _results
    );
}
