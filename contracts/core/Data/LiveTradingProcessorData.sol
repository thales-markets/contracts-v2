// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../interfaces/ILiveTradingProcessor.sol";
import "../../interfaces/IFreeBetsHolder.sol";

contract LiveTradingProcessorData is Initializable, ProxyOwned, ProxyPausable {
    /* ========== STRUCT VARIABLES ========== */

    struct RequestData {
        address user;
        bytes32 requestId;
        address ticketId;
        bool isFulfilled;
        uint timestamp;
        uint maturityTimestamp;
        string gameId;
        uint16 sportId;
        uint16 typeId;
        int24 line;
        uint8 position;
        uint buyInAmount;
        uint expectedQuote;
        uint additionalSlippage;
        address referrer;
        address collateral;
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

        requestsData = new RequestData[](_pageSize);

        _pageSize = _pageSize > requestsSize - _startIndex ? requestsSize - _startIndex : _pageSize;
        for (uint i = _startIndex; i < (_startIndex + _pageSize); i++) {
            bytes32 requestId = liveTradingProcessor.counterToRequestId(i);
            address requester = liveTradingProcessor.requestIdToRequester(requestId);
            address ticketId = liveTradingProcessor.requestIdToTicketId(requestId);
            uint timestampPerRequest = liveTradingProcessor.timestampPerRequest(requestId);
            ILiveTradingProcessor.LiveTradeData memory liveTradeData = liveTradingProcessor.getTradeData(requestId);

            requestsData[i] = RequestData({
                user: requester,
                requestId: requestId,
                ticketId: ticketId,
                isFulfilled: liveTradingProcessor.requestIdFulfilled(requestId),
                timestamp: timestampPerRequest,
                maturityTimestamp: timestampPerRequest + liveTradingProcessor.maxAllowedExecutionDelay(),
                gameId: liveTradeData._gameId,
                sportId: liveTradeData._sportId,
                typeId: liveTradeData._typeId,
                line: liveTradeData._line,
                position: liveTradeData._position,
                buyInAmount: liveTradeData._buyInAmount,
                expectedQuote: liveTradeData._expectedQuote,
                additionalSlippage: liveTradeData._additionalSlippage,
                referrer: liveTradeData._referrer,
                collateral: liveTradeData._collateral
            });
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
            if (requester == address(freeBetsHolder)) {
                requester = freeBetsHolder.ticketToUser(ticketId);
            }
            if (requester != user) continue;

            uint timestampPerRequest = liveTradingProcessor.timestampPerRequest(requestId);
            ILiveTradingProcessor.LiveTradeData memory liveTradeData = liveTradingProcessor.getTradeData(requestId);

            requestsData[count] = RequestData({
                user: requester,
                requestId: requestId,
                ticketId: ticketId,
                isFulfilled: liveTradingProcessor.requestIdFulfilled(requestId),
                timestamp: timestampPerRequest,
                maturityTimestamp: timestampPerRequest + liveTradingProcessor.maxAllowedExecutionDelay(),
                gameId: liveTradeData._gameId,
                sportId: liveTradeData._sportId,
                typeId: liveTradeData._typeId,
                line: liveTradeData._line,
                position: liveTradeData._position,
                buyInAmount: liveTradeData._buyInAmount,
                expectedQuote: liveTradeData._expectedQuote,
                additionalSlippage: liveTradeData._additionalSlippage,
                referrer: liveTradeData._referrer,
                collateral: liveTradeData._collateral
            });

            count++;
            if (count == _maxSize) break;
        }
    }

    function setLiveTradingProcessor(ILiveTradingProcessor _liveTradingProcessor) external onlyOwner {
        liveTradingProcessor = _liveTradingProcessor;
        emit LiveTradingProcessorChanged(address(_liveTradingProcessor));
    }

    function setFreeBetsHolder(IFreeBetsHolder _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit LiveTradingProcessorChanged(address(_freeBetsHolder));
    }

    event LiveTradingProcessorChanged(address liveTradingProcessor);
    event FreeBetsHolderChanged(address freeBetsHolder);
}
