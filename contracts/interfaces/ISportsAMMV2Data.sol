// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ISportsAMMV2.sol";

interface ISportsAMMV2Data {
    struct MarketData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint maturity;
        int24 line;
        uint24 playerId;
        uint8 position;
        uint odd;
        ISportsAMMV2.CombinedPosition[] combinedPositions;
    }

    struct MarketResult {
        ISportsAMMV2ResultManager.MarketPositionStatus status;
        int24[] results;
    }

    struct TicketData {
        address id;
        MarketData[] marketsData;
        MarketResult[] marketsResult;
        address collateral;
        address ticketOwner;
        uint buyInAmount;
        uint fees;
        uint totalQuote;
        uint numOfMarkets;
        uint expiry;
        uint createdAt;
        bool resolved;
        bool paused;
        bool cancelled;
        bool isLost;
        bool isUserTheWinner;
        bool isExercisable;
        uint finalPayout;
        bool isLive;
    }

    function getTicketsDataPerGame(
        bytes32 gameId,
        uint _startIndex,
        uint _pageSize
    ) external view returns (TicketData[] memory);
}
