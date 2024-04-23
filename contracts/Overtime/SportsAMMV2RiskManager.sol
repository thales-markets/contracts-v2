// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";

import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2.sol";
import "../interfaces/ISportsAMMV2ResultManager.sol";

/// @title Sports AMM V2 Risk Manager contract
/// @author vladan
contract SportsAMMV2RiskManager is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONST VARIABLES ========== */

    uint public constant MIN_SPORT_NUMBER = 9000;
    uint public constant MIN_TYPE_NUMBER = 10000;
    uint public constant DEFAULT_DYNAMIC_LIQUIDITY_CUTOFF_DIVIDER = 2e18;
    uint private constant ONE = 1e18;

    /* ========== STATE VARIABLES ========== */

    // sports manager contract address
    ISportsAMMV2Manager public manager;

    // result manager address
    ISportsAMMV2ResultManager public resultManager;

    // sports AMM address
    ISportsAMMV2 public sportsAMM;

    // default cap for all sports
    uint public defaultCap;

    // cap per specific sport
    mapping(uint => uint) public capPerSport;

    // cap per all child markets of specific sport
    mapping(uint => uint) public capPerSportChild;

    // cap per type for specific sport
    mapping(uint => mapping(uint => uint)) public capPerSportAndType;

    // cap per specific market
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(int => uint)))) public capPerMarket;

    // default risk multiplier used to calculate total risk on the game
    uint public defaultRiskMultiplier;

    // risk multiplier per sport used to calculate total risk on the game
    mapping(uint => uint) public riskMultiplierPerSport;

    // risk multiplier per game used to calculate total risk on the game
    mapping(bytes32 => uint) public riskMultiplierPerGame;

    // max available cap
    uint public maxCap;

    // max available risk multiplier
    uint public maxRiskMultiplier;

    // time before maturity when to start increasing the liquidity linearly
    mapping(uint => uint) public dynamicLiquidityCutoffTimePerSport;

    // divider on how much liquidity is available before cut off time
    mapping(uint => uint) public dynamicLiquidityCutoffDividerPerSport;

    mapping(uint => mapping(uint => bool)) public liveTradingPerSportAndTypeEnabled;

    mapping(uint => bool) public combiningPerSportEnabled;

    // stores current risk per market type and position, defined with gameId -> typeId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => int)))) public riskPerMarketTypeAndPosition;

    // spent on game (parent market together with all child markets)
    mapping(bytes32 => uint) public spentOnGame;

    // minimum ticket buy-in amount
    uint public minBuyInAmount;

    // maximum ticket size
    uint public maxTicketSize;

    // maximum supported payout amount
    uint public maxSupportedAmount;

    // maximum supported ticket odds
    uint public maxSupportedOdds;

    // the period of time in seconds before a market is matured and begins to be restricted for AMM trading
    uint public minimalTimeLeftToMaturity;

    // the period of time in seconds after mauturity when ticket expires
    uint public expiryDuration;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        address _owner,
        ISportsAMMV2Manager _manager,
        ISportsAMMV2ResultManager _resultManager,
        uint _defaultCap,
        uint _defaultRiskMultiplier,
        uint _maxCap,
        uint _maxRiskMultiplier
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        manager = _manager;
        resultManager = _resultManager;
        defaultCap = _defaultCap;
        defaultRiskMultiplier = _defaultRiskMultiplier;
        maxCap = _maxCap;
        maxRiskMultiplier = _maxRiskMultiplier;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice calculate which cap needs to be applied to the given game
    /// @param _gameId to get cap for
    /// @param _sportId to get cap for
    /// @param _typeId to get cap for
    /// @param _playerId to get cap for
    /// @param _maturity used for dynamic liquidity check
    /// @param _line used for dynamic liquidity check
    /// @return cap cap to use
    function calculateCapToBeUsed(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _maturity
    ) external view returns (uint cap) {
        return _calculateCapToBeUsed(_gameId, _sportId, _typeId, _playerId, _line, _maturity);
    }

    /// @notice calculate max available total risk on game
    /// @param _gameId to total risk for
    /// @param _sportId to total risk for
    /// @return totalRisk total risk
    function calculateTotalRiskOnGame(
        bytes32 _gameId,
        uint16 _sportId,
        uint _maturity
    ) external view returns (uint totalRisk) {
        return _calculateTotalRiskOnGame(_gameId, _sportId, _maturity);
    }

    /// @notice check risk for ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @return riskStatus risk status
    /// @return isMarketOutOfLiquidity array of boolean values that indicates if some market is out of liquidity
    function checkRisks(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount
    ) external view returns (ISportsAMMV2RiskManager.RiskStatus riskStatus, bool[] memory isMarketOutOfLiquidity) {
        uint numOfMarkets = _tradeData.length;
        isMarketOutOfLiquidity = new bool[](numOfMarkets);

        for (uint i = 0; i < numOfMarkets; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            uint amountToBuy = (ONE * _buyInAmount) / marketTradeData.odds[marketTradeData.position];
            if (amountToBuy > _buyInAmount) {
                uint marketRiskAmount = amountToBuy - _buyInAmount;

                if (
                    _isRiskPerMarketAndPositionExceeded(marketTradeData, marketRiskAmount) ||
                    _isRiskPerGameExceeded(marketTradeData, marketRiskAmount)
                ) {
                    isMarketOutOfLiquidity[i] = true;
                    riskStatus = ISportsAMMV2RiskManager.RiskStatus.OutOfLiquidity;
                } else if (_isInvalidCombinationOnTicket(_tradeData, marketTradeData, i)) {
                    riskStatus = ISportsAMMV2RiskManager.RiskStatus.InvalidCombination;
                }
            }
        }
    }

    /// @notice check limits for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _totalQuote ticket quote
    /// @param _payout actual payout
    /// @param _expectedPayout expected payout got from quote method
    /// @param _additionalSlippage slippage tolerance
    function checkLimits(
        uint _buyInAmount,
        uint _totalQuote,
        uint _payout,
        uint _expectedPayout,
        uint _additionalSlippage
    ) external view {
        // apply all checks
        require(_buyInAmount >= minBuyInAmount, "Low buy-in amount");
        require(_totalQuote >= maxSupportedOdds, "Exceeded max supported odds");
        require((_payout - _buyInAmount) <= maxSupportedAmount, "Exceeded max supported amount");
        require(((ONE * _expectedPayout) / _payout) <= (ONE + _additionalSlippage), "Slippage too high");
    }

    /// @notice returns risk data for given sports and types
    /// @param _sportIds sport IDs to get data for
    /// @param _typeIds type IDs to get data for
    /// @return riskData risk data
    function getRiskData(
        uint[] memory _sportIds,
        uint[] memory _typeIds
    ) external view returns (ISportsAMMV2RiskManager.RiskData[] memory riskData) {
        riskData = new ISportsAMMV2RiskManager.RiskData[](_sportIds.length);

        for (uint i = 0; i < _sportIds.length; i++) {
            uint sportId = _sportIds[i];

            ISportsAMMV2RiskManager.TypeCap[] memory capPerType = new ISportsAMMV2RiskManager.TypeCap[](_typeIds.length);

            for (uint j = 0; j < _typeIds.length; j++) {
                uint typeId = _typeIds[j];
                capPerType[j] = ISportsAMMV2RiskManager.TypeCap(typeId, capPerSportAndType[sportId][typeId]);
            }

            ISportsAMMV2RiskManager.CapData memory capData = ISportsAMMV2RiskManager.CapData(
                capPerSport[sportId],
                capPerSportChild[sportId],
                capPerType
            );

            ISportsAMMV2RiskManager.DynamicLiquidityData memory dynamicLiquidityData = ISportsAMMV2RiskManager
                .DynamicLiquidityData(
                    dynamicLiquidityCutoffTimePerSport[sportId],
                    dynamicLiquidityCutoffDividerPerSport[sportId]
                );

            riskData[i] = ISportsAMMV2RiskManager.RiskData(
                sportId,
                capData,
                riskMultiplierPerSport[sportId],
                dynamicLiquidityData
            );
        }
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice check and update risks for ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    function checkAndUpdateRisks(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount
    ) external onlySportsAMM(msg.sender) {
        for (uint i = 0; i < _tradeData.length; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];
            uint[] memory odds = marketTradeData.odds;
            uint8 position = marketTradeData.position;

            require(odds.length > position, "Invalid position");
            require(_isMarketInAMMTrading(marketTradeData), "Not trading");

            uint amountToBuy = odds[position] == 0 ? 0 : (ONE * _buyInAmount) / odds[position];
            if (amountToBuy > _buyInAmount) {
                uint marketRiskAmount = amountToBuy - _buyInAmount;

                require(
                    !_isRiskPerMarketAndPositionExceeded(marketTradeData, marketRiskAmount),
                    "Risk per market and position exceeded"
                );
                require(!_isRiskPerGameExceeded(marketTradeData, marketRiskAmount), "Risk per game exceeded");
                require(!_isInvalidCombinationOnTicket(_tradeData, marketTradeData, i), "Invalid combination detected");
                _updateRisk(marketTradeData, marketRiskAmount);
            }
        }
    }

    function verifyMerkleTree(ISportsAMMV2.TradeData memory marketTradeData) external view {
        // Compute the merkle leaf from trade data
        bytes memory encodePackedOutput = abi.encodePacked(
            marketTradeData.gameId,
            uint(marketTradeData.sportId),
            uint(marketTradeData.typeId),
            marketTradeData.maturity,
            uint(marketTradeData.status),
            int(marketTradeData.line),
            uint(marketTradeData.playerId),
            marketTradeData.odds
        );

        for (uint i; i < marketTradeData.combinedPositions.length; i++) {
            for (uint j; j < marketTradeData.combinedPositions[i].length; j++) {
                encodePackedOutput = abi.encodePacked(
                    encodePackedOutput,
                    uint(marketTradeData.combinedPositions[i][j].typeId),
                    uint(marketTradeData.combinedPositions[i][j].position),
                    int(marketTradeData.combinedPositions[i][j].line)
                );
            }
        }

        bytes32 leaf = keccak256(encodePackedOutput);
        // verify the proof is valid
        require(
            MerkleProof.verify(marketTradeData.merkleProof, sportsAMM.rootPerGame(marketTradeData.gameId), leaf),
            "Proof is not valid"
        );
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _isMarketInAMMTrading(ISportsAMMV2.TradeData memory _marketTradeData) internal view returns (bool isTrading) {
        uint maturity = _marketTradeData.maturity;

        bool isResolved = resultManager.isMarketResolved(
            _marketTradeData.gameId,
            _marketTradeData.typeId,
            _marketTradeData.playerId,
            _marketTradeData.line,
            _marketTradeData.combinedPositions[_marketTradeData.position]
        );
        if (_marketTradeData.status == 0 && !isResolved) {
            if (maturity >= block.timestamp) {
                isTrading = (maturity - block.timestamp) > minimalTimeLeftToMaturity;
            }
        }
    }

    function _isRiskPerMarketAndPositionExceeded(
        ISportsAMMV2.TradeData memory _marketTradeData,
        uint marketRiskAmount
    ) internal view returns (bool) {
        bytes32 gameId = _marketTradeData.gameId;
        uint16 typeId = _marketTradeData.typeId;
        uint16 playerId = _marketTradeData.playerId;

        return
            riskPerMarketTypeAndPosition[gameId][typeId][playerId][_marketTradeData.position] + int(marketRiskAmount) >
            int(
                _calculateCapToBeUsed(
                    gameId,
                    _marketTradeData.sportId,
                    typeId,
                    playerId,
                    _marketTradeData.line,
                    _marketTradeData.maturity
                )
            );
    }

    function _isRiskPerGameExceeded(
        ISportsAMMV2.TradeData memory _marketTradeData,
        uint marketRiskAmount
    ) internal view returns (bool) {
        bytes32 gameId = _marketTradeData.gameId;
        return
            (spentOnGame[gameId] + marketRiskAmount) >
            _calculateTotalRiskOnGame(gameId, _marketTradeData.sportId, _marketTradeData.maturity);
    }

    function _isInvalidCombinationOnTicket(
        ISportsAMMV2.TradeData[] memory _tradeData,
        ISportsAMMV2.TradeData memory _currentTradaData,
        uint currentIndex
    ) internal view returns (bool) {
        for (uint j = currentIndex + 1; j < _tradeData.length; j++) {
            ISportsAMMV2.TradeData memory tradeDataToCheckAgainst = _tradeData[j];
            if (
                _currentTradaData.gameId == tradeDataToCheckAgainst.gameId &&
                _currentTradaData.sportId == tradeDataToCheckAgainst.sportId
            ) {
                if (
                    !combiningPerSportEnabled[_currentTradaData.sportId] ||
                    _currentTradaData.playerId == tradeDataToCheckAgainst.playerId ||
                    _currentTradaData.playerId == 0 ||
                    tradeDataToCheckAgainst.playerId == 0
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    function _updateRisk(ISportsAMMV2.TradeData memory _marketTradeData, uint marketRiskAmount) internal {
        bytes32 gameId = _marketTradeData.gameId;
        uint16 typeId = _marketTradeData.typeId;
        uint16 playerId = _marketTradeData.playerId;
        uint8 position = _marketTradeData.position;

        for (uint j = 0; j < _marketTradeData.odds.length; j++) {
            int currentRiskPerMarketTypeAndPosition = riskPerMarketTypeAndPosition[gameId][typeId][playerId][j];
            if (j == position) {
                riskPerMarketTypeAndPosition[gameId][typeId][playerId][j] =
                    currentRiskPerMarketTypeAndPosition +
                    int(marketRiskAmount);
            } else {
                riskPerMarketTypeAndPosition[gameId][typeId][playerId][j] =
                    currentRiskPerMarketTypeAndPosition -
                    int(marketRiskAmount);
            }
        }
        spentOnGame[gameId] += marketRiskAmount;
    }

    function _calculateRiskMultiplier(bytes32 _gameId, uint16 _sportId) internal view returns (uint gameRisk) {
        gameRisk = riskMultiplierPerGame[_gameId];

        if (gameRisk == 0) {
            uint riskPerSport = riskMultiplierPerSport[_sportId];
            gameRisk = riskPerSport > 0 ? riskPerSport : defaultRiskMultiplier;
        }
    }

    function _calculateCapToBeUsed(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _maturity
    ) internal view returns (uint cap) {
        if (_maturity > block.timestamp) {
            cap = capPerMarket[_gameId][_typeId][_playerId][_line];
            if (cap == 0) {
                uint sportCap = capPerSport[_sportId];
                sportCap = sportCap > 0 ? sportCap : defaultCap;
                cap = sportCap;

                if (_typeId > 0) {
                    cap = capPerSportChild[_sportId];
                    if (cap == 0) {
                        uint typeCap = capPerSportAndType[_sportId][_typeId];
                        cap = typeCap > 0 ? typeCap : sportCap / 2;
                    }
                }
            }

            uint dynamicLiquidityCutoffTime = dynamicLiquidityCutoffTimePerSport[_sportId];
            if (dynamicLiquidityCutoffTime > 0) {
                uint timeToStart = _maturity - block.timestamp;
                uint cutOffLiquidity = (cap * ONE) /
                    (
                        dynamicLiquidityCutoffDividerPerSport[_sportId] > 0
                            ? dynamicLiquidityCutoffDividerPerSport[_sportId]
                            : DEFAULT_DYNAMIC_LIQUIDITY_CUTOFF_DIVIDER
                    );
                if (timeToStart >= dynamicLiquidityCutoffTime) {
                    cap = cutOffLiquidity;
                } else {
                    uint remainingFromCutOff = cap - cutOffLiquidity;
                    cap =
                        cutOffLiquidity +
                        (((dynamicLiquidityCutoffTime - timeToStart) * remainingFromCutOff) / dynamicLiquidityCutoffTime);
                }
            }
        }
    }

    function _calculateTotalRiskOnGame(
        bytes32 _gameId,
        uint16 _sportId,
        uint _maturity
    ) internal view returns (uint totalRisk) {
        // get cap for parent market
        uint capToBeUsed = _calculateCapToBeUsed(_gameId, _sportId, 0, 0, 0, _maturity);
        uint riskMultiplier = _calculateRiskMultiplier(_gameId, _sportId);

        return (capToBeUsed * riskMultiplier);
    }

    /* ========== SETTERS ========== */

    /// @notice sets whether props SGPs are allowed on the given sport
    /// @param _sportID sport to set enabled for
    /// @param _enabled true/false
    function setCombiningPerSportEnabled(uint _sportID, bool _enabled) external onlyOwner {
        combiningPerSportEnabled[_sportID] = _enabled;
        emit SetCombiningPerSportEnabled(_sportID, _enabled);
    }

    /// @notice sets the max cap and max risk multiplier
    /// @param _maxCap max cap
    /// @param _maxRiskMultiplier max risk multiplier
    function setMaxCapAndMaxRiskMultiplier(uint _maxCap, uint _maxRiskMultiplier) external onlyOwner {
        require(_maxCap > defaultCap && _maxRiskMultiplier > defaultRiskMultiplier, "Invalid input");
        maxCap = _maxCap;
        maxRiskMultiplier = _maxRiskMultiplier;
        emit SetMaxCapAndMaxRiskMultiplier(_maxCap, _maxRiskMultiplier);
    }

    /// @notice sets the default cap and default risk multiplier
    /// @param _defaultCap default cap
    /// @param _defaultRiskMultiplier default risk multiplier
    function setDefaultCapAndDefaultRiskMultiplier(uint _defaultCap, uint _defaultRiskMultiplier) external onlyOwner {
        require(_defaultCap <= maxCap && _defaultRiskMultiplier <= maxRiskMultiplier, "Invalid input");
        defaultCap = _defaultCap;
        defaultRiskMultiplier = _defaultRiskMultiplier;
        emit SetDefaultCapAndDefaultRiskMultiplier(_defaultCap, _defaultRiskMultiplier);
    }

    /// @notice sets the cap per sport (batch)
    /// @param _sportIds sport IDs to set cap for
    /// @param _capsPerSport the cap amounts
    function setCapsPerSport(
        uint[] memory _sportIds,
        uint[] memory _capsPerSport
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _sportIds.length; i++) {
            _setCapPerSport(_sportIds[i], _capsPerSport[i]);
        }
    }

    /// @notice sets the cap per all child markets of specific sport (batch)
    /// @param _sportIds sport IDs to set cap for
    /// @param _capsPerSportChild the cap amounts
    function setCapsPerSportChild(
        uint[] memory _sportIds,
        uint[] memory _capsPerSportChild
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _sportIds.length; i++) {
            _setCapPerSportChild(_sportIds[i], _capsPerSportChild[i]);
        }
    }

    /// @notice sets the cap per sport and type (batch)
    /// @param _sportIds sport IDs to set cap for
    /// @param _typeIds type IDs to set cap for
    /// @param _capsPerType the cap amounts
    function setCapsPerSportAndType(
        uint[] memory _sportIds,
        uint[] memory _typeIds,
        uint[] memory _capsPerType
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _sportIds.length; i++) {
            _setCapPerSportAndType(_sportIds[i], _typeIds[i], _capsPerType[i]);
        }
    }

    /// @notice sets the caps per specific markets
    /// @param _gameIds game IDs to set cap for
    /// @param _typeIds type IDs to set cap for
    /// @param _playerIds player IDs to set cap for
    /// @param _lines lines to set cap for
    /// @param _capsPerMarket the cap amounts
    function setCapsPerMarket(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint16[] memory _playerIds,
        int24[] memory _lines,
        uint[] memory _capsPerMarket
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _gameIds.length; i++) {
            require(_capsPerMarket[i] <= maxCap, "Invalid cap");
            capPerMarket[_gameIds[i]][_typeIds[i]][_playerIds[i]][_lines[i]] = _capsPerMarket[i];
            emit SetCapPerMarket(_gameIds[i], _typeIds[i], _playerIds[i], _lines[i], _capsPerMarket[i]);
        }
    }

    /// @notice sets the cap per sport, cap per sport child and cap per sport and type (batch)
    /// @param _sportIds sport IDs to set cap for
    /// @param _capsPerSport the cap amounts used for the sport IDs
    /// @param _sportIdsForChild sport IDs to set child cap for
    /// @param _capsPerSportChild the cap amounts used for the sport child markets
    /// @param _sportIdsForType sport IDs to set type cap for
    /// @param _typeIds type IDs to set cap for
    /// @param _capsPerSportAndType the cap amounts used for the sport IDs and type IDs
    function setCaps(
        uint[] memory _sportIds,
        uint[] memory _capsPerSport,
        uint[] memory _sportIdsForChild,
        uint[] memory _capsPerSportChild,
        uint[] memory _sportIdsForType,
        uint[] memory _typeIds,
        uint[] memory _capsPerSportAndType
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _sportIds.length; i++) {
            _setCapPerSport(_sportIds[i], _capsPerSport[i]);
        }
        for (uint i; i < _sportIdsForChild.length; i++) {
            _setCapPerSportChild(_sportIdsForChild[i], _capsPerSportChild[i]);
        }
        for (uint i; i < _sportIdsForType.length; i++) {
            _setCapPerSportAndType(_sportIdsForType[i], _typeIds[i], _capsPerSportAndType[i]);
        }
    }

    /// @notice sets the risk multiplier per sport (batch)
    /// @param _sportIds sport IDs to set risk multiplier for
    /// @param _riskMultipliersPerSport the risk multiplier amounts
    function setRiskMultipliersPerSport(
        uint[] memory _sportIds,
        uint[] memory _riskMultipliersPerSport
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _sportIds.length; i++) {
            require(_sportIds[i] > MIN_SPORT_NUMBER, "Invalid ID for sport");
            require(_riskMultipliersPerSport[i] <= maxRiskMultiplier, "Invalid multiplier");
            riskMultiplierPerSport[_sportIds[i]] = _riskMultipliersPerSport[i];
            emit SetRiskMultiplierPerSport(_sportIds[i], _riskMultipliersPerSport[i]);
        }
    }

    /// @notice sets the risk multiplier per spec. games
    /// @param _gameIds game IDs to set risk multiplier for
    /// @param _riskMultipliersPerGame the risk multiplier amounts used for the specific games
    function setRiskMultipliersPerGame(
        bytes32[] memory _gameIds,
        uint[] memory _riskMultipliersPerGame
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _gameIds.length; i++) {
            require(_riskMultipliersPerGame[i] <= maxRiskMultiplier, "Invalid multiplier");
            riskMultiplierPerGame[_gameIds[i]] = _riskMultipliersPerGame[i];
            emit SetRiskMultiplierPerGame(_gameIds[i], _riskMultipliersPerGame[i]);
        }
    }

    /// @notice sets the dynamic liquidity params
    /// @param _sportId the ID used for sport
    /// @param _dynamicLiquidityCutoffTime when to start increasing the liquidity linearly, if 0 assume 100% liquidity all the time since game creation
    /// @param _dynamicLiquidityCutoffDivider e.g. if 2 it means liquidity up until cut off time is 50%, then increases linearly. if 0 use default
    function setDynamicLiquidityParamsPerSport(
        uint _sportId,
        uint _dynamicLiquidityCutoffTime,
        uint _dynamicLiquidityCutoffDivider
    ) external onlyWhitelistedAddresses(msg.sender) {
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        dynamicLiquidityCutoffTimePerSport[_sportId] = _dynamicLiquidityCutoffTime;
        dynamicLiquidityCutoffDividerPerSport[_sportId] = _dynamicLiquidityCutoffDivider;
        emit SetDynamicLiquidityParams(_sportId, _dynamicLiquidityCutoffTime, _dynamicLiquidityCutoffDivider);
    }

    /// @notice sets the sports manager contract address
    /// @param _manager the address of sports manager contract
    function setSportsManager(address _manager) external onlyOwner {
        require(_manager != address(0), "Invalid address");
        manager = ISportsAMMV2Manager(_manager);
        emit SetSportsManager(_manager);
    }

    /// @notice sets the result manager contract address
    /// @param _resultManager the address of result manager contract
    function setResultManager(address _resultManager) external onlyOwner {
        require(_resultManager != address(0), "Invalid address");
        resultManager = ISportsAMMV2ResultManager(_resultManager);
        emit SetResultManager(_resultManager);
    }

    /// @notice sets the Sports AMM contract address
    /// @param _sportsAMM the address of Sports AMM contract
    function setSportsAMM(address _sportsAMM) external onlyOwner {
        require(_sportsAMM != address(0), "Invalid address");
        sportsAMM = ISportsAMMV2(_sportsAMM);
        emit SetSportsAMM(_sportsAMM);
    }

    /// @notice Setting whether live trading per sport is enabled
    /// @param _sportId to set live trading for
    /// @param _typeId to set live trading for
    /// @param _enabled self explanatory
    function setLiveTradingPerSportAndTypeEnabled(uint _sportId, uint _typeId, bool _enabled) external onlyOwner {
        liveTradingPerSportAndTypeEnabled[_sportId][_typeId] = _enabled;
        emit SetLiveTradingPerSportAndTypeEnabled(_sportId, _typeId, _enabled);
    }

    /// @notice sets different ticket parameters
    /// @param _minBuyInAmount minimum ticket buy-in amount
    /// @param _maxTicketSize maximum ticket size
    /// @param _maxSupportedAmount maximum supported payout amount
    /// @param _maxSupportedOdds  maximum supported ticket odds
    function setTicketParams(
        uint _minBuyInAmount,
        uint _maxTicketSize,
        uint _maxSupportedAmount,
        uint _maxSupportedOdds
    ) external onlyOwner {
        minBuyInAmount = _minBuyInAmount;
        maxTicketSize = _maxTicketSize;
        maxSupportedAmount = _maxSupportedAmount;
        maxSupportedOdds = _maxSupportedOdds;
        emit TicketParamsUpdated(_minBuyInAmount, _maxTicketSize, _maxSupportedAmount, _maxSupportedOdds);
    }

    /// @notice sets different times/periods
    /// @param _minimalTimeLeftToMaturity  the period of time in seconds before a game is matured and begins to be restricted for AMM trading
    /// @param _expiryDuration the period of time in seconds after mauturity when ticket expires
    function setTimes(uint _minimalTimeLeftToMaturity, uint _expiryDuration) external onlyOwner {
        minimalTimeLeftToMaturity = _minimalTimeLeftToMaturity;
        expiryDuration = _expiryDuration;
        emit TimesUpdated(_minimalTimeLeftToMaturity, _expiryDuration);
    }

    /* ========== INTERNAL SETTERS ========== */

    function _setCapPerSport(uint _sportId, uint _capPerSport) internal {
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        require(_capPerSport <= maxCap, "Invalid cap");
        capPerSport[_sportId] = _capPerSport;
        emit SetCapPerSport(_sportId, _capPerSport);
    }

    function _setCapPerSportChild(uint _sportId, uint _capPerSportChild) internal {
        uint currentCapPerSport = capPerSport[_sportId] > 0 ? capPerSport[_sportId] : defaultCap;
        require(_capPerSportChild <= currentCapPerSport, "Invalid cap");
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        capPerSportChild[_sportId] = _capPerSportChild;
        emit SetCapPerSportChild(_sportId, _capPerSportChild);
    }

    function _setCapPerSportAndType(uint _sportId, uint _typeId, uint _capPerType) internal {
        uint currentCapPerSport = capPerSport[_sportId] > 0 ? capPerSport[_sportId] : defaultCap;
        require(_capPerType <= currentCapPerSport, "Invalid cap");
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        require(_typeId > MIN_TYPE_NUMBER, "Invalid ID for type");
        capPerSportAndType[_sportId][_typeId] = _capPerType;
        emit SetCapPerSportAndType(_sportId, _typeId, _capPerType);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyWhitelistedAddresses(address sender) {
        require(
            sender == owner || manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.RISK_MANAGING),
            "Invalid sender"
        );
        _;
    }

    modifier onlySportsAMM(address sender) {
        require(sender == address(sportsAMM), "Only the AMM may perform these methods");
        _;
    }

    /* ========== EVENTS ========== */

    event SetMaxCapAndMaxRiskMultiplier(uint maxCap, uint maxRiskMultiplier);
    event SetDefaultCapAndDefaultRiskMultiplier(uint defaultCap, uint defaultRiskMultiplier);

    event SetCapPerSport(uint sportId, uint cap);
    event SetCapPerSportChild(uint sportId, uint cap);
    event SetCapPerSportAndType(uint sportId, uint typeId, uint cap);
    event SetCapPerMarket(bytes32 gameId, uint16 typeId, uint16 playerId, int24 line, uint cap);

    event SetRiskMultiplierPerSport(uint sportId, uint riskMultiplier);
    event SetRiskMultiplierPerGame(bytes32 gameId, uint riskMultiplier);

    event SetDynamicLiquidityParams(uint sportId, uint dynamicLiquidityCutoffTime, uint dynamicLiquidityCutoffDivider);
    event SetSportsManager(address manager);
    event SetResultManager(address resultManager);
    event SetSportsAMM(address sportsAMM);
    event SetLiveTradingPerSportAndTypeEnabled(uint _sportId, uint _typeId, bool _enabled);
    event SetCombiningPerSportEnabled(uint _sportID, bool _enabled);
    event TicketParamsUpdated(uint minBuyInAmount, uint maxTicketSize, uint maxSupportedAmount, uint maxSupportedOdds);
    event TimesUpdated(uint minimalTimeLeftToMaturity, uint expiryDuration);
}
