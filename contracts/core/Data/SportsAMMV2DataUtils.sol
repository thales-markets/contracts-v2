// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "./../AMM/Ticket.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";

contract SportsAMMV2DataUtils {
    struct TicketLegState {
        address ticket;
        bool[] resolved;
        bool[] voided;
        uint[] marketOdds;
    }

    struct MarketStakeCalculationInput {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint24 playerId;
        int24 line;
        uint maturity;
        bool isLive;
        uint8 position;
        uint odds;
    }

    struct TicketMarketInfo {
        bytes32 gameId;
        uint16 typeId;
        uint24 playerId;
        int24 line;
    }

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
        bool isSystem;
        uint8 systemBetDenominator;
        bool isSGP;
        bool cashedOut;
        bool isPotentiallyCashoutable;
    }

    function getTicketLegStatesBatch(address[] calldata tickets) external view returns (TicketLegState[] memory out) {
        uint tLen = tickets.length;
        out = new TicketLegState[](tLen);

        for (uint ti; ti < tLen; ++ti) {
            address ticketAddr = tickets[ti];
            Ticket t = Ticket(ticketAddr);
            uint legs = t.numOfMarkets();

            bool[] memory resolved = new bool[](legs);
            bool[] memory voided = new bool[](legs);
            uint[] memory marketOdds = new uint[](legs);

            for (uint li; li < legs; ++li) {
                resolved[li] = t.isLegResolved(li);
                voided[li] = t.isLegVoided(li);
                marketOdds[li] = t.getMarketOdd(li);
            }

            out[ti] = TicketLegState({ticket: ticketAddr, resolved: resolved, voided: voided, marketOdds: marketOdds});
        }
    }

    function getMaxStakeAndLiquidityBatch(
        ISportsAMMV2RiskManager _riskManager,
        MarketStakeCalculationInput[] calldata inputs
    ) external view returns (uint[] memory maxStakes, uint[] memory availableLiquidity) {
        uint len = inputs.length;
        maxStakes = new uint[](len);
        availableLiquidity = new uint[](len);

        for (uint i; i < len; ++i) {
            maxStakes[i] = _calculateMaxStakeAndLiquidity(_riskManager, inputs[i], availableLiquidity, i);
        }
    }

    function _calculateMaxStakeAndLiquidity(
        ISportsAMMV2RiskManager _riskManager,
        MarketStakeCalculationInput calldata input,
        uint[] memory availableLiquidity,
        uint index
    ) internal view returns (uint maxStake) {
        uint cap = _riskManager.calculateCapToBeUsed(
            input.gameId,
            input.sportId,
            input.typeId,
            input.playerId,
            input.line,
            input.maturity,
            input.isLive
        );

        int available = int(cap) -
            _riskManager.riskPerMarketTypeAndPosition(input.gameId, input.typeId, input.playerId, input.position);

        uint availablePerPosition = available > 0 ? uint(available) : 0;
        availableLiquidity[index] = availablePerPosition;

        uint totalGameCap = _riskManager.calculateTotalRiskOnGame(input.gameId, input.sportId, input.maturity);
        uint spent = _riskManager.spentOnGame(input.gameId);

        if (input.odds > 0 && input.odds < 1e18) {
            uint denominator = 1e18 - input.odds;
            uint availablePerGame = totalGameCap > spent ? totalGameCap - spent : 0;
            uint usableLiquidity = availablePerPosition < availablePerGame ? availablePerPosition : availablePerGame;
            maxStake = (usableLiquidity * input.odds) / denominator;
        }
    }

    function getFreeBetsDataPerUser(
        IFreeBetsHolder freeBetsHolder,
        address user,
        address[] calldata collateralAddresses
    ) external view returns (uint[] memory freeBetsAmountPerCollateral, uint[] memory freeBetsExpiryPerCollateral) {
        uint len = collateralAddresses.length;
        freeBetsAmountPerCollateral = new uint[](len);
        freeBetsExpiryPerCollateral = new uint[](len);

        uint upgradeExpiration = freeBetsHolder.freeBetExpirationUpgrade() + freeBetsHolder.freeBetExpirationPeriod();
        uint timestamp = block.timestamp;

        for (uint i; i < len; ++i) {
            address collateral = collateralAddresses[i];

            freeBetsAmountPerCollateral[i] = freeBetsHolder.balancePerUserAndCollateral(user, collateral);

            uint expiration = freeBetsHolder.freeBetExpiration(user, collateral);
            expiration = expiration == 0 ? upgradeExpiration : expiration;

            freeBetsExpiryPerCollateral[i] = expiration > timestamp ? expiration - timestamp : 0;
        }
    }

    function getOnlyActiveGameIdsAndTicketsOf(
        ISportsAMMV2Manager manager,
        bytes32[] calldata _gameIds,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (bytes32[] memory activeGameIds, uint[] memory numOfTicketsPerGameId, address[][] memory ticketsPerGameId)
    {
        return _getOnlyActiveGameIdsAndTicketsOf(manager, _gameIds, _startIndex, _pageSize);
    }

    function _getOnlyActiveGameIdsAndTicketsOf(
        ISportsAMMV2Manager manager,
        bytes32[] calldata _gameIds,
        uint _startIndex,
        uint _pageSize
    )
        internal
        view
        returns (bytes32[] memory activeGameIds, uint[] memory numOfTicketsPerGameId, address[][] memory ticketsPerGameId)
    {
        _pageSize = _pageSize > _gameIds.length ? _gameIds.length : _pageSize;

        uint[] memory ticketsPerGame = new uint[](_pageSize);
        uint counter;

        for (uint i = _startIndex; i < _pageSize; ++i) {
            uint numOfTicketsPerGame = manager.numOfTicketsPerGame(_gameIds[i]);
            if (numOfTicketsPerGame > 0) {
                counter++;
                ticketsPerGame[i] = numOfTicketsPerGame;
            }
        }

        activeGameIds = new bytes32[](counter);
        numOfTicketsPerGameId = new uint[](counter);
        ticketsPerGameId = new address[][](counter);

        counter = 0;
        for (uint i; i < _gameIds.length; ++i) {
            if (i < ticketsPerGame.length && ticketsPerGame[i] > 0) {
                activeGameIds[counter] = _gameIds[i];
                numOfTicketsPerGameId[counter] = ticketsPerGame[i];
                ticketsPerGameId[counter] = manager.getTicketsPerGame(0, ticketsPerGame[i], _gameIds[i]);
                counter++;
            }
        }
    }

    function getAllActiveGameIdsTypeIdsPlayerIdsLinesForGameIds(
        ISportsAMMV2Manager manager,
        bytes32[] calldata _gameIds,
        uint _startIndex,
        uint _pageSize
    ) external view returns (TicketMarketInfo[] memory finalTicketsInfo) {
        bytes32[] memory activeGameIds;
        uint[] memory numOfTicketsPerGameId;
        address[][] memory ticketsPerGameId;

        (activeGameIds, numOfTicketsPerGameId, ticketsPerGameId) = _getOnlyActiveGameIdsAndTicketsOf(
            manager,
            _gameIds,
            _startIndex,
            _pageSize
        );

        uint matchCounter;
        for (uint i; i < activeGameIds.length; ++i) {
            for (uint j; j < numOfTicketsPerGameId[i]; ++j) {
                matchCounter += Ticket(ticketsPerGameId[i][j]).numOfMarkets();
            }
        }

        TicketMarketInfo[] memory ticketsMarkets = new TicketMarketInfo[](matchCounter);
        matchCounter = 0;

        for (uint i; i < activeGameIds.length; ++i) {
            for (uint j; j < numOfTicketsPerGameId[i]; ++j) {
                Ticket ticket = Ticket(ticketsPerGameId[i][j]);
                uint numOfMarkets = ticket.numOfMarkets();

                for (uint t; t < numOfMarkets; ++t) {
                    (bytes32 gameId, , uint16 typeId, , , int24 line, uint24 playerId, , ) = ticket.markets(t);

                    ticketsMarkets[matchCounter].gameId = gameId;
                    ticketsMarkets[matchCounter].typeId = typeId;
                    ticketsMarkets[matchCounter].playerId = playerId;
                    ticketsMarkets[matchCounter].line = line;
                    ++matchCounter;
                }
            }
        }

        (matchCounter, numOfTicketsPerGameId) = _getUniqueTypeIdsPlayerIds(ticketsMarkets);

        finalTicketsInfo = new TicketMarketInfo[](matchCounter);
        matchCounter = 0;

        for (uint i; i < ticketsMarkets.length; ++i) {
            if (numOfTicketsPerGameId[i] == 1) {
                finalTicketsInfo[matchCounter] = ticketsMarkets[i];
                ++matchCounter;
            }
        }
    }

    function _getUniqueTypeIdsPlayerIds(
        TicketMarketInfo[] memory ticketsMarkets
    ) internal pure returns (uint numOfUniqueMatches, uint[] memory uniqueIndexes) {
        bytes32[] memory uniqueHashes = new bytes32[](ticketsMarkets.length);
        uniqueIndexes = new uint[](ticketsMarkets.length);

        for (uint i; i < ticketsMarkets.length; ++i) {
            bytes32 currentHash = keccak256(abi.encode(ticketsMarkets[i]));
            bool isUnique = true;

            for (uint j; j < numOfUniqueMatches; ++j) {
                if (currentHash == uniqueHashes[j]) {
                    isUnique = false;
                    break;
                }
            }

            if (isUnique) {
                uniqueHashes[numOfUniqueMatches] = currentHash;
                uniqueIndexes[i] = 1;
                ++numOfUniqueMatches;
            }
        }
    }

    function getTicketsData(
        ISportsAMMV2 _sportsAMM,
        ISportsAMMV2RiskManager _riskManager,
        address[] calldata ticketsArray
    ) external view returns (TicketData[] memory) {
        return _getTicketsData(_sportsAMM, _riskManager, ticketsArray);
    }

    function _getTicketsData(
        ISportsAMMV2 _sportsAMM,
        ISportsAMMV2RiskManager _riskManager,
        address[] calldata ticketsArray
    ) internal view returns (TicketData[] memory) {
        TicketData[] memory tickets = new TicketData[](ticketsArray.length);
        ISportsAMMV2Manager manager = _sportsAMM.manager();

        for (uint i; i < ticketsArray.length; ++i) {
            Ticket ticket = Ticket(ticketsArray[i]);

            (MarketData[] memory marketsData, MarketResult[] memory marketsResult) = _getTicketMarketsData(
                _sportsAMM,
                ticket
            );
            (bool isSystem, bool isSGP, bool cashedOut, bool isPotentiallyCashoutable) = _getTicketCashoutData(
                _sportsAMM,
                _riskManager,
                ticket,
                manager
            );

            tickets[i] = _buildTicketData(
                ticketsArray[i],
                ticket,
                marketsData,
                marketsResult,
                isSystem,
                isSGP,
                cashedOut,
                isPotentiallyCashoutable
            );
        }

        return tickets;
    }

    function _getTicketMarketsData(
        ISportsAMMV2 _sportsAMM,
        Ticket ticket
    ) internal view returns (MarketData[] memory marketsData, MarketResult[] memory marketsResult) {
        uint numOfMarkets = ticket.numOfMarkets();
        marketsData = new MarketData[](numOfMarkets);
        marketsResult = new MarketResult[](numOfMarkets);

        for (uint j; j < numOfMarkets; ++j) {
            marketsData[j] = _getMarketData(ticket, j);
            marketsResult[j] = _getMarketResult(_sportsAMM, ticket, j);
        }
    }

    function _getTicketCashoutData(
        ISportsAMMV2 _sportsAMM,
        ISportsAMMV2RiskManager _riskManager,
        Ticket ticket,
        ISportsAMMV2Manager manager
    ) internal view returns (bool isSystem, bool isSGP, bool cashedOut, bool isPotentiallyCashoutable) {
        isSystem = manager.isSystemTicket(address(ticket));
        isSGP = manager.isSGPTicket(address(ticket));

        bool createdAfterCashoutDeploy = manager.isTicketPotentiallyCashoutable(address(ticket));
        address ticketOwner = ticket.ticketOwner();

        if (createdAfterCashoutDeploy) {
            cashedOut = ticket.cashedOut();
        }

        bool passedCashoutCooldown = block.timestamp >= ticket.createdAt() + _riskManager.getCashoutCooldown();

        isPotentiallyCashoutable =
            !ticket.resolved() &&
            !ticket.isTicketLost() &&
            !isSGP &&
            !isSystem &&
            createdAfterCashoutDeploy &&
            passedCashoutCooldown &&
            ticket.totalQuote() > _riskManager.maxSupportedOdds() &&
            ticketOwner != address(_sportsAMM.freeBetsHolder());
    }

    function _buildTicketData(
        address ticketAddress,
        Ticket ticket,
        MarketData[] memory marketsData,
        MarketResult[] memory marketsResult,
        bool isSystem,
        bool isSGP,
        bool cashedOut,
        bool isPotentiallyCashoutable
    ) internal view returns (TicketData memory) {
        return
            TicketData(
                ticketAddress,
                marketsData,
                marketsResult,
                address(ticket.collateral()),
                ticket.ticketOwner(),
                ticket.buyInAmount(),
                ticket.fees(),
                ticket.totalQuote(),
                ticket.numOfMarkets(),
                ticket.expiry(),
                ticket.createdAt(),
                ticket.resolved(),
                ticket.paused(),
                ticket.cancelled(),
                ticket.isTicketLost(),
                ticket.isUserTheWinner(),
                ticket.isTicketExercisable(),
                ticket.finalPayout(),
                ticket.isLive(),
                isSystem,
                isSystem ? ticket.systemBetDenominator() : 0,
                isSGP,
                cashedOut,
                isPotentiallyCashoutable
            );
    }

    function _getMarketData(Ticket ticket, uint marketIndex) internal view returns (MarketData memory) {
        (
            bytes32 gameId,
            uint16 sportId,
            uint16 typeId,
            uint maturity,
            ,
            int24 line,
            uint24 playerId,
            uint8 position,
            uint odd
        ) = ticket.markets(marketIndex);

        ISportsAMMV2.CombinedPosition[] memory combinedPositions = ticket.getCombinedPositions(marketIndex);

        return MarketData(gameId, sportId, typeId, maturity, line, playerId, position, odd, combinedPositions);
    }

    function _getMarketResult(
        ISportsAMMV2 _sportsAMM,
        Ticket ticket,
        uint marketIndex
    ) internal view returns (MarketResult memory) {
        (bytes32 gameId, , uint16 typeId, , , int24 line, uint24 playerId, uint8 position, ) = ticket.markets(marketIndex);
        ISportsAMMV2.CombinedPosition[] memory combinedPositions = ticket.getCombinedPositions(marketIndex);
        ISportsAMMV2ResultManager resultManager = _sportsAMM.resultManager();

        return
            MarketResult(
                resultManager.getMarketPositionStatus(gameId, typeId, playerId, line, position, combinedPositions),
                resultManager.getResultsPerMarket(gameId, typeId, playerId)
            );
    }
}
