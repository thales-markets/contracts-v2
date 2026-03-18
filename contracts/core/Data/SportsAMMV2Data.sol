// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";
import "../../interfaces/IFreeBetsHolder.sol";
import "./../AMM/Ticket.sol";
import "./SportsAMMV2DataUtils.sol";

contract SportsAMMV2Data is Initializable, ProxyOwned, ProxyPausable {
    /* ========== STRUCT VARIABLES ========== */
    struct SportsAMMParameters {
        uint minBuyInAmount;
        uint maxTicketSize;
        uint maxSupportedAmount;
        uint maxSupportedOdds;
        uint safeBoxFee;
        bool paused;
        uint maxAllowedSystemCombinations;
    }

    enum ResultType {
        Unassigned,
        ExactPosition,
        OverUnder,
        CombinedPositions
    }

    /* ========== STATE VARIABLES ========== */

    ISportsAMMV2 public sportsAMM;

    ISportsAMMV2RiskManager public riskManager;

    SportsAMMV2DataUtils public dataUtils;

    function initialize(address _owner, ISportsAMMV2 _sportsAMM, ISportsAMMV2RiskManager _riskManager) external initializer {
        setOwner(_owner);
        sportsAMM = _sportsAMM;
        riskManager = _riskManager;
    }

    /**
     * @notice Retrieves the parameters used by the SportsAMM contract.
     * @dev Returns a struct containing various configurable parameters for the SportsAMM.
     * @return A `SportsAMMParameters` struct containing:
     * - `minBuyInAmount`: Minimum buy-in amount.
     * - `maxTicketSize`: Maximum size of a single ticket.
     * - `maxSupportedAmount`: Maximum amount supported by the AMM.
     * - `maxSupportedOdds`: Maximum odds supported by the AMM.
     * - `safeBoxFee`: Fee for the safe box.
     * - `paused`: Whether the SportsAMM is currently paused.
     * - `maxAllowedSystemCombinations`: Maximum allowed system combinations.
     */
    function getSportsAMMParameters() external view returns (SportsAMMParameters memory) {
        return
            SportsAMMParameters(
                riskManager.minBuyInAmount(),
                riskManager.maxTicketSize(),
                riskManager.maxSupportedAmount(),
                riskManager.maxSupportedOdds(),
                sportsAMM.safeBoxFee(),
                sportsAMM.paused(),
                riskManager.maxAllowedSystemCombinations()
            );
    }

    /**
     * @notice Retrieves data for the specified tickets.
     * @dev Fetches ticket information for a given array of ticket addresses.
     * @param ticketsArray An array of ticket addresses to retrieve data for.
     * @return An array of `TicketData` containing details for each ticket.
     */
    function getTicketsData(
        address[] calldata ticketsArray
    ) external view returns (SportsAMMV2DataUtils.TicketData[] memory) {
        require(address(dataUtils) != address(0), "DataUtils not set");
        return dataUtils.getTicketsData(sportsAMM, riskManager, ticketsArray);
    }

    /**
     * @notice Batch-reads per-leg states for multiple tickets.
     * @dev Returns one struct per ticket, each holding its own leg arrays.
     *
     * @param tickets Array of Ticket addresses.
     * @return out Array of TicketLegState (same order as input).
     */
    function getTicketLegStatesBatch(
        address[] calldata tickets
    ) external view returns (SportsAMMV2DataUtils.TicketLegState[] memory out) {
        require(address(dataUtils) != address(0), "DataUtils not set");
        return dataUtils.getTicketLegStatesBatch(tickets);
    }

    /**
     * @notice Retrieves active ticket data for a specific user within a paginated range.
     * @dev Fetches data for active tickets, free bets, and staking proxy tickets.
     * @param user The address of the user.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return ticketsData Active tickets data.
     * @return freeBetsData Free bets data.
     * @return stakingBettingProxyData Staking proxy tickets data.
     */
    function getActiveTicketsDataPerUser(
        address user,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (
            SportsAMMV2DataUtils.TicketData[] memory ticketsData,
            SportsAMMV2DataUtils.TicketData[] memory freeBetsData,
            SportsAMMV2DataUtils.TicketData[] memory stakingBettingProxyData
        )
    {
        require(address(dataUtils) != address(0), "DataUtils not set");
        address[] memory freeBetsArray = sportsAMM.freeBetsHolder().getActiveTicketsPerUser(_startIndex, _pageSize, user);
        address[] memory ticketsArray = sportsAMM.manager().getActiveTicketsPerUser(_startIndex, _pageSize, user);
        ticketsData = dataUtils.getTicketsData(sportsAMM, riskManager, ticketsArray);
        freeBetsData = dataUtils.getTicketsData(sportsAMM, riskManager, freeBetsArray);
        // Return empty array for stakingBettingProxyData without making any external calls
        stakingBettingProxyData = new SportsAMMV2DataUtils.TicketData[](0);
    }

    /**
     * @notice Retrieves free bets data for a specific user.
     * @dev Fetches free bets data for a given user and collateral addresses.
     * @param user The address of the user.
     * @param collateralAddresses An array of collateral addresses to retrieve free bets data for.
     * @return freeBetsAmountPerCollateral An array of free bets amounts for each collateral address.
     * @return freeBetsExpiryPerCollateral An array of free bets expiries for each collateral address.
     */
    function getFreeBetsDataPerUser(
        address user,
        address[] calldata collateralAddresses
    ) external view returns (uint[] memory freeBetsAmountPerCollateral, uint[] memory freeBetsExpiryPerCollateral) {
        require(address(dataUtils) != address(0), "DataUtils not set");
        return dataUtils.getFreeBetsDataPerUser(sportsAMM.freeBetsHolder(), user, collateralAddresses);
    }

    /**
     * @notice Retrieves resolved ticket data for a specific user within a paginated range.
     * @dev Fetches data for resolved tickets, free bets, and staking proxy tickets.
     * @param user The address of the user.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return ticketsData Resolved tickets data.
     * @return freeBetsData Free bets data.
     * @return stakingBettingProxyData Staking proxy tickets data.
     */
    function getResolvedTicketsDataPerUser(
        address user,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (
            SportsAMMV2DataUtils.TicketData[] memory ticketsData,
            SportsAMMV2DataUtils.TicketData[] memory freeBetsData,
            SportsAMMV2DataUtils.TicketData[] memory stakingBettingProxyData
        )
    {
        require(address(dataUtils) != address(0), "DataUtils not set");

        address[] memory freeBetsArray = sportsAMM.freeBetsHolder().getResolvedTicketsPerUser(_startIndex, _pageSize, user);
        address[] memory ticketsArray = sportsAMM.manager().getResolvedTicketsPerUser(_startIndex, _pageSize, user);
        ticketsData = dataUtils.getTicketsData(sportsAMM, riskManager, ticketsArray);
        freeBetsData = dataUtils.getTicketsData(sportsAMM, riskManager, freeBetsArray);
        // Return empty array for stakingBettingProxyData without making any external calls
        stakingBettingProxyData = new SportsAMMV2DataUtils.TicketData[](0);
    }

    /**
     * @notice Retrieves ticket data for a specific game within a paginated range.
     * @dev Fetches ticket information for tickets associated with the given game ID.
     * @param gameId The ID of the game to retrieve tickets for.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return An array of `TicketData` containing details for the tickets of the specified game.
     */
    function getTicketsDataPerGame(
        bytes32 gameId,
        uint _startIndex,
        uint _pageSize
    ) external view returns (SportsAMMV2DataUtils.TicketData[] memory) {
        require(address(dataUtils) != address(0), "DataUtils not set");

        ISportsAMMV2Manager manager = sportsAMM.manager();
        uint numOfTicketsPerGame = manager.numOfTicketsPerGame(gameId);
        _pageSize = _pageSize > numOfTicketsPerGame ? numOfTicketsPerGame : _pageSize;
        address[] memory ticketsArray = manager.getTicketsPerGame(_startIndex, _pageSize, gameId);
        return dataUtils.getTicketsData(sportsAMM, riskManager, ticketsArray);
    }

    /**
     * @notice Retrieves active game IDs and their associated tickets within a paginated range.
     * @dev Filters only active game IDs and retrieves tickets for each game ID.
     * @param _gameIds An array of game IDs to filter and process.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of entries to fetch in the current page.
     * @return activeGameIds An array of active game IDs.
     * @return numOfTicketsPerGameId An array of ticket counts for each active game ID.
     * @return ticketsPerGameId A 2D array of ticket addresses for each active game ID.
     */
    function getOnlyActiveGameIdsAndTicketsOf(
        bytes32[] calldata _gameIds,
        uint _startIndex,
        uint _pageSize
    )
        external
        view
        returns (bytes32[] memory activeGameIds, uint[] memory numOfTicketsPerGameId, address[][] memory ticketsPerGameId)
    {
        require(address(dataUtils) != address(0), "DataUtils not set");
        return dataUtils.getOnlyActiveGameIdsAndTicketsOf(sportsAMM.manager(), _gameIds, _startIndex, _pageSize);
    }

    /**
     * @notice Retrieves all active game IDs, type IDs, player IDs, and lines for the specified game IDs within a paginated range.
     * @dev Processes active game IDs and tickets, retrieving unique type IDs, player IDs, and market lines.
     * @param _gameIds An array of game IDs to filter and process.
     * @param _startIndex The starting index for pagination.
     * @param _pageSize The number of game IDs to process in the current page.
     * @return finalTicketsInfo An array of TicketMarketInfo containing active market details for the specified game IDs.
     */
    function getAllActiveGameIdsTypeIdsPlayerIdsLinesForGameIds(
        bytes32[] calldata _gameIds,
        uint _startIndex,
        uint _pageSize
    ) external view returns (SportsAMMV2DataUtils.TicketMarketInfo[] memory finalTicketsInfo) {
        require(address(dataUtils) != address(0), "DataUtils not set");
        return
            dataUtils.getAllActiveGameIdsTypeIdsPlayerIdsLinesForGameIds(
                sportsAMM.manager(),
                _gameIds,
                _startIndex,
                _pageSize
            );
    }

    /**
     * @notice Checks if specified markets are resolved.
     * @dev Determines the resolution status of markets by querying the result manager.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _typeIds An array of type IDs associated with the markets.
     * @param _playerIds An array of player IDs associated with the markets.
     * @param _lines An array of market lines for the specified markets.
     * @return resolvedMarkets An array of booleans indicating whether each market is resolved.
     */
    function areMarketsResolved(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds,
        int24[] memory _lines
    ) external view returns (bool[] memory resolvedMarkets) {
        ISportsAMMV2ResultManager resultManager = sportsAMM.resultManager();
        ISportsAMMV2.CombinedPosition[] memory combinedPositions = new ISportsAMMV2.CombinedPosition[](0);
        if (_gameIds.length == _typeIds.length && _typeIds.length == _playerIds.length) {
            resolvedMarkets = new bool[](_gameIds.length);
            for (uint i = 0; i < _gameIds.length; ++i) {
                uint8 resultType = resultManager.resultTypePerMarketType(_typeIds[i]);
                if (resultType != uint8(ResultType.CombinedPositions)) {
                    resolvedMarkets[i] = resultManager.isMarketResolved(
                        _gameIds[i],
                        _typeIds[i],
                        _playerIds[i],
                        _lines[i],
                        combinedPositions
                    );
                }
            }
        }
    }

    /**
     * @notice Retrieves the results for the specified markets.
     * @dev Queries the result manager for results based on game, type, and player IDs.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _typeIds An array of type IDs associated with the markets.
     * @param _playerIds An array of player IDs associated with the markets.
     * @return resultsForMarkets A 2D array containing market results for each specified market.
     */
    function getResultsForMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds
    ) external view returns (int24[][] memory resultsForMarkets) {
        ISportsAMMV2ResultManager resultManager = sportsAMM.resultManager();
        if (_gameIds.length == _typeIds.length && _typeIds.length == _playerIds.length) {
            resultsForMarkets = new int24[][](_gameIds.length);
            for (uint i; i < _gameIds.length; ++i) {
                resultsForMarkets[i] = resultManager.getResultsPerMarket(_gameIds[i], _typeIds[i], _playerIds[i]);
            }
        }
    }

    /**
     * @notice Retrieves the amount spent on specified games.
     * @dev Queries the risk manager for the spent amounts for each game ID.
     * @param _gameIds An array of game IDs to calculate the spent amounts for.
     * @return spentAmounts An array of spent amounts corresponding to each game ID.
     */
    function getSpentOnGames(bytes32[] calldata _gameIds) external view returns (uint[] memory spentAmounts) {
        spentAmounts = new uint[](_gameIds.length);
        for (uint i; i < _gameIds.length; ++i) {
            spentAmounts[i] = riskManager.spentOnGame(_gameIds[i]);
        }
    }

    /**
     * @notice Retrieves the risk amounts for specific market positions.
     * @dev This function queries the risk manager to get the risk per market type and position.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _typeIds An array of type IDs representing the types of the markets.
     * @param _playerIds An array of player IDs associated with the markets.
     * @param _positions An array of positions in the markets.
     * @return riskAmounts An array of risk amounts corresponding to the provided market details.
     */
    function getRiskOnMarkets(
        bytes32[] calldata _gameIds,
        uint[] calldata _typeIds,
        uint[] calldata _playerIds,
        uint[] calldata _positions
    ) external view returns (int[] memory riskAmounts) {
        riskAmounts = new int[](_gameIds.length);
        for (uint i; i < _gameIds.length; ++i) {
            riskAmounts[i] = riskManager.riskPerMarketTypeAndPosition(
                _gameIds[i],
                _typeIds[i],
                _playerIds[i],
                _positions[i]
            );
        }
    }

    /**
     * @notice Calculates max stake and available liquidity for each market+position input.
     * @dev Returns two arrays: maxStake and availableLiquidity, both on decimals matching the default collateral.
     * @param inputs Array of market definitions and odds.
     * @return maxStakes Array of maximum stake values.
     * @return availableLiquidity Array of available risk the house is willing to take.
     */
    function getMaxStakeAndLiquidityBatch(
        SportsAMMV2DataUtils.MarketStakeCalculationInput[] calldata inputs
    ) external view returns (uint[] memory maxStakes, uint[] memory availableLiquidity) {
        require(address(dataUtils) != address(0), "DataUtils not set");
        return dataUtils.getMaxStakeAndLiquidityBatch(riskManager, inputs);
    }

    /**
     * @notice Calculates the caps for specific markets based on their details.
     * @dev This function queries the risk manager to determine the cap to be used for each market.
     * @param _gameIds An array of game IDs representing the markets.
     * @param _sportIds An array of sport IDs associated with the markets.
     * @param _typeIds An array of type IDs representing the types of the markets.
     * @param _maturities An array of maturities (timestamps) for the markets.
     * @return caps An array of cap values corresponding to the provided market details.
     */
    function getCapsPerMarkets(
        bytes32[] calldata _gameIds,
        uint16[] calldata _sportIds,
        uint16[] calldata _typeIds,
        uint[] calldata _maturities
    ) external view returns (uint[] memory caps) {
        caps = new uint[](_gameIds.length);
        for (uint i; i < _gameIds.length; ++i) {
            caps[i] = riskManager.calculateCapToBeUsed(_gameIds[i], _sportIds[i], _typeIds[i], 0, 0, _maturities[i], false);
        }
    }

    /**
     * @notice Returns cashout quote and payout data for a ticket.
     * @dev Delegates to Ticket using approved per-leg odds and settled flags.
     *      Applies cashout fee via multiplier (currently hardcoded).
     * @param ticket Ticket address.
     * @param approvedOddsPerLeg Approved per-leg implied probabilities (1e18).
     * @param isLegSettled Flags indicating whether each leg is settled.
     * @return quote Combined implied probability for cashout.
     * @return payoutAfterFee Cashout payout after fee.
     */
    function getCashoutQuoteAndPayout(
        address ticket,
        uint[] calldata approvedOddsPerLeg,
        bool[] calldata isLegSettled
    ) external view returns (uint quote, uint payoutAfterFee) {
        ISportsAMMV2Manager manager = sportsAMM.manager();
        if (!manager.isTicketPotentiallyCashoutable(ticket) || !manager.isActiveTicket(ticket)) {
            return (0, 0);
        }

        return Ticket(ticket).getCashoutQuoteAndPayout(approvedOddsPerLeg, isLegSettled);
    }

    function setAddresses(ISportsAMMV2 _sportsAMM, ISportsAMMV2RiskManager _riskManager) external onlyOwner {
        sportsAMM = _sportsAMM;
        riskManager = _riskManager;
        emit AddressesUpdated(address(_sportsAMM), address(_riskManager));
    }

    function setDataUtils(SportsAMMV2DataUtils _dataUtils) external onlyOwner {
        dataUtils = _dataUtils;
        emit DataUtilsUpdated(address(_dataUtils));
    }

    event AddressesUpdated(address sportsAMM, address riskManager);
    event DataUtilsUpdated(address dataUtils);
}
