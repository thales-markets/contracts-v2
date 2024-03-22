// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

// external
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./SportsAMMV2.sol";

contract LiveTradingProcessor is ChainlinkClient, Ownable, Pausable {
    using Chainlink for Chainlink.Request;
    using SafeERC20 for IERC20;

    SportsAMMV2 public sportsAMM;

    bytes32 public specId;

    uint public payment;

    struct LiveTradeData {
        bytes32 gameId;
        uint16 sportId;
        uint8 position;
        uint _buyInAmount;
        uint _expectedPayout;
        uint _additionalSlippage;
        address _differentRecipient;
        address _referrer;
        address _collateral;
    }

    mapping(bytes32 => LiveTradeData) public requestIdToTradeData;
    mapping(bytes32 => uint) public timestampPerRequest;

    uint public requestCounter;
    mapping(uint => bytes32) public counterToRequestId;

    constructor(address _link, address _oracle, address _sportsAMM, bytes32 _specId, uint _payment) Ownable(msg.sender) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        sportsAMM = SportsAMMV2(_sportsAMM);
        specId = _specId;
        payment = _payment;
    }

    function requestLiveTrade(
        bytes32 gameId,
        uint16 sportId,
        uint8 _position,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address _collateral
    ) external whenNotPaused {
        Chainlink.Request memory req;

        req = buildChainlinkRequest(specId, address(this), this.fulfillLiveTrade.selector);

        req.add("gameId", string(abi.encodePacked(gameId)));
        req.addUint("sportId", sportId);
        req.addUint("_buyInAmount", _buyInAmount);
        req.addUint("_expectedPayout", _expectedPayout);
        req.addUint("_additionalSlippage", _additionalSlippage);

        if (_differentRecipient == address(0)) {
            _differentRecipient = msg.sender;
        }

        bytes32 requestId = sendChainlinkRequest(req, payment);
        timestampPerRequest[requestId] = block.timestamp;
        requestIdToTradeData[requestId] = LiveTradeData(
            gameId,
            sportId,
            _position,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            _differentRecipient,
            _referrer,
            _collateral
        );

        counterToRequestId[requestCounter++] = requestId;
    }

    function fulfillLiveTrade(bytes32 _requestId, bool allow) external recordChainlinkFulfillment(_requestId) {
        if (allow) {
            LiveTradeData memory lTradeData = requestIdToTradeData[_requestId];

            ISportsAMMV2.TradeData[] memory tradeData = new ISportsAMMV2.TradeData[](1);
            bytes32[] memory merkleProofs;
            uint[] memory odds = new uint[](3);
            ISportsAMMV2.CombinedPosition[][] memory comPositions = new ISportsAMMV2.CombinedPosition[][](3);

            tradeData[0] = ISportsAMMV2.TradeData(
                lTradeData.gameId,
                lTradeData.sportId,
                0, //type, set moneyline
                block.timestamp + 60, //maturity, hardcode to timestamp with buffer
                0, //status
                0, //line
                0, //playerId
                odds, //odds[]
                merkleProofs, //merkleProof[]
                lTradeData.position,
                comPositions //combinedPositions[]
            );

            sportsAMM.tradeLive(
                tradeData,
                lTradeData._buyInAmount,
                lTradeData._expectedPayout,
                lTradeData._additionalSlippage,
                lTradeData._differentRecipient,
                lTradeData._referrer,
                lTradeData._collateral
            );
        }
        //TODO: handle for trade not allowed
    }

    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }
}
