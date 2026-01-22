// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/IFreeBetsHolder.sol";

contract LiveTradingProcessorData is Initializable, ProxyOwned, ProxyPausable {
    /* ========== STRUCT VARIABLES ========== */

    struct Leg {
        string gameId;
        uint16 sportId;
        uint16 typeId;
        int24 line;
        uint8 position;
        uint24 playerId;
        uint expectedQuote;
    }

    struct RequestData {
        address user;
        bytes32 requestId;
        address ticketId;
        bool isFulfilled;
        uint timestamp;
        uint maturityTimestamp;
        uint buyInAmount;
        uint expectedPayout;
        uint additionalSlippage;
        address referrer;
        address collateral;
        bool isFreeBet;
        Leg[] legs;
    }

    /* ========== STATE VARIABLES ========== */

    ILiveTradingProcessor public liveTradingProcessor;
    IFreeBetsHolder public freeBetsHolder;

    function initialize(address _owner, ILiveTradingProcessor _liveTradingProcessor) external initializer {
        setOwner(_owner);
        liveTradingProcessor = _liveTradingProcessor;
    }

    /**
     * @notice Retrieves requests data within a paginated range.
     * @dev Fetches requests data in batches.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return requestsData Requests data.
     */
    function getRequestsData(uint _startIndex, uint _pageSize) external view returns (RequestData[] memory requestsData) {
        uint requestsSize = liveTradingProcessor.requestCounter();
        uint remaining = requestsSize > _startIndex ? requestsSize - _startIndex : 0;
        uint size = _pageSize > remaining ? remaining : _pageSize;

        requestsData = new RequestData[](size);

        for (uint i = 0; i < size; ++i) {
            uint requestIndex = _startIndex + i;
            bytes32 requestId = liveTradingProcessor.counterToRequestId(requestIndex);
            address requester = liveTradingProcessor.requestIdToRequester(requestId);
            address ticketId = liveTradingProcessor.requestIdToTicketId(requestId);
            uint timestampPerRequest = liveTradingProcessor.timestampPerRequest(requestId);
            bool isFreeBet = requester == address(freeBetsHolder);
            bool isLiveParlay = liveTradingProcessor.requestIdIsParlay(requestId);

            requestsData[i] = isLiveParlay
                ? _processParlayTrade(requestId, requester, ticketId, timestampPerRequest, isFreeBet)
                : _processSingleTrade(requestId, requester, ticketId, timestampPerRequest, isFreeBet);
        }
    }

    /**
     * @notice Retrieves latest live requests data for a specific user within search range.
     * @dev Fetches latest requests data for a specific user by iterating all requests backwards inside provided range.
     * @param user The address of the user.
     * @param _batchSize The number of latest requests to iterate.
     * @param _maxSize The max number of requests to fetch for a user.
     * @return requestsData Requests data.
     */
    function getLatestRequestsDataPerUser(
        address user,
        uint _batchSize,
        uint _maxSize
    ) external view returns (RequestData[] memory requestsData) {
        uint count = 0;
        uint requestsSize = liveTradingProcessor.requestCounter();

        requestsData = new RequestData[](_maxSize);

        _batchSize = _batchSize > requestsSize ? 0 : requestsSize - _batchSize;
        // iterate backwards in order to fetch most recent data
        for (uint i = requestsSize; i > _batchSize; --i) {
            bytes32 requestId = liveTradingProcessor.counterToRequestId(i - 1);
            address requester = liveTradingProcessor.requestIdToRequester(requestId);
            address ticketId = liveTradingProcessor.requestIdToTicketId(requestId);
            bool isFreeBet = requester == address(freeBetsHolder);
            if (isFreeBet) {
                requester = freeBetsHolder.ticketToUser(ticketId);
            }
            if (requester != user) continue;

            uint timestampPerRequest = liveTradingProcessor.timestampPerRequest(requestId);
            bool isLiveParlay = liveTradingProcessor.requestIdIsParlay(requestId);

            requestsData[count] = isLiveParlay
                ? _processParlayTrade(requestId, requester, ticketId, timestampPerRequest, isFreeBet)
                : _processSingleTrade(requestId, requester, ticketId, timestampPerRequest, isFreeBet);

            ++count;
            if (count == _maxSize) break;
        }
    }

    function _processSingleTrade(
        bytes32 _requestId,
        address _requester,
        address _ticketId,
        uint _timestampPerRequest,
        bool _isFreeBet
    ) private view returns (RequestData memory) {
        ILiveTradingProcessor.LiveTradeData memory liveTradeData = liveTradingProcessor.getTradeData(_requestId);

        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg({
            gameId: liveTradeData._gameId,
            sportId: liveTradeData._sportId,
            typeId: liveTradeData._typeId,
            line: liveTradeData._line,
            position: liveTradeData._position,
            playerId: liveTradeData._playerId,
            expectedQuote: liveTradeData._expectedQuote
        });

        return
            RequestData({
                user: _requester,
                requestId: _requestId,
                ticketId: _ticketId,
                isFulfilled: liveTradingProcessor.requestIdFulfilled(_requestId),
                timestamp: _timestampPerRequest,
                maturityTimestamp: _timestampPerRequest + liveTradingProcessor.maxAllowedExecutionDelay(),
                buyInAmount: liveTradeData._buyInAmount,
                expectedPayout: liveTradeData._expectedQuote,
                additionalSlippage: liveTradeData._additionalSlippage,
                referrer: liveTradeData._referrer,
                collateral: liveTradeData._collateral,
                isFreeBet: _isFreeBet,
                legs: legs
            });
    }

    function _processParlayTrade(
        bytes32 _requestId,
        address _requester,
        address _ticketId,
        uint _timestampPerRequest,
        bool _isFreeBet
    ) private view returns (RequestData memory) {
        ILiveTradingProcessor.LiveParlayTradeData memory liveParlayTradeData = liveTradingProcessor.getParlayTradeData(
            _requestId
        );

        Leg[] memory legs = new Leg[](liveParlayTradeData.legs.length);
        for (uint j = 0; j < liveParlayTradeData.legs.length; ++j) {
            ILiveTradingProcessor.LiveParlayLeg memory leg = liveParlayTradeData.legs[j];
            legs[j] = Leg({
                gameId: leg.gameId,
                sportId: leg.sportId,
                typeId: leg.typeId,
                line: leg.line,
                position: leg.position,
                playerId: leg.playerId,
                expectedQuote: leg.expectedLegOdd
            });
        }

        return
            RequestData({
                user: _requester,
                requestId: _requestId,
                ticketId: _ticketId,
                isFulfilled: liveTradingProcessor.requestIdFulfilled(_requestId),
                timestamp: _timestampPerRequest,
                maturityTimestamp: _timestampPerRequest + liveTradingProcessor.maxAllowedExecutionDelay(),
                buyInAmount: liveParlayTradeData.buyInAmount,
                expectedPayout: liveParlayTradeData.expectedPayout,
                additionalSlippage: liveParlayTradeData.additionalSlippage,
                referrer: liveParlayTradeData.referrer,
                collateral: liveParlayTradeData.collateral,
                isFreeBet: _isFreeBet,
                legs: legs
            });
    }

    function setLiveTradingProcessor(ILiveTradingProcessor _liveTradingProcessor) external onlyOwner {
        liveTradingProcessor = _liveTradingProcessor;
        emit LiveTradingProcessorChanged(address(_liveTradingProcessor));
    }

    function setFreeBetsHolder(IFreeBetsHolder _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit FreeBetsHolderChanged(address(_freeBetsHolder));
    }

    event LiveTradingProcessorChanged(address liveTradingProcessor);
    event FreeBetsHolderChanged(address freeBetsHolder);
}
