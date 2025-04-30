// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../interfaces/ILiveTradingProcessor.sol";

contract LiveTradingProcessorData is Initializable, ProxyOwned, ProxyPausable {
    /* ========== STRUCT VARIABLES ========== */

    struct RequestData {
        address user;
        bytes32 requestId;
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

        for (uint i = _startIndex; i < requestsSize; i++) {
            if ((i - _startIndex) == _pageSize) break;

            bytes32 requestId = liveTradingProcessor.counterToRequestId(i);
            address requester = liveTradingProcessor.requestIdToRequester(requestId);
            uint timestampPerRequest = liveTradingProcessor.timestampPerRequest(requestId);
            ILiveTradingProcessor.LiveTradeData memory liveTradeData = liveTradingProcessor.getTradeData(requestId);

            requestsData[i] = RequestData({
                user: requester,
                requestId: requestId,
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

        // iterate backwards in order to fetch most recent data
        for (uint i = requestsSize; i > 0; --i) {
            if ((requestsSize - i) == _batchSize) break;

            bytes32 requestId = liveTradingProcessor.counterToRequestId(i - 1);
            address requester = liveTradingProcessor.requestIdToRequester(requestId);
            if (requester != user) continue;

            uint timestampPerRequest = liveTradingProcessor.timestampPerRequest(requestId);
            ILiveTradingProcessor.LiveTradeData memory liveTradeData = liveTradingProcessor.getTradeData(requestId);

            requestsData[count] = RequestData({
                user: requester,
                requestId: requestId,
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

    event LiveTradingProcessorChanged(address liveTradingProcessor);
}
