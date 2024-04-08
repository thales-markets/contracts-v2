// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";

import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";

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

    // risk multiplier per market used to calculate total risk on the game
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(int => uint)))) public riskMultiplierPerMarket;

    // max available cap
    uint public maxCap;

    // max available risk multiplier
    uint public maxRiskMultiplier;

    // time before maturity when to start increasing the liquidity linearly
    mapping(uint => uint) public dynamicLiquidityCutoffTimePerSport;

    // divider on how much liquidity is available before cut off time
    mapping(uint => uint) public dynamicLiquidityCutoffDividerPerSport;

    mapping(uint => mapping(uint => bool)) public liveTradingPerSportAndTypeEnabled;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        address _owner,
        address _manager,
        uint _defaultCap,
        uint _defaultRiskMultiplier,
        uint _maxCap,
        uint _maxRiskMultiplier
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        defaultCap = _defaultCap;
        defaultRiskMultiplier = _defaultRiskMultiplier;
        maxCap = _maxCap;
        maxRiskMultiplier = _maxRiskMultiplier;
        manager = ISportsAMMV2Manager(_manager);
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

    /// @notice returns if game is in to much of a risk
    /// @param _totalSpent total spent on game
    /// @param _gameId for which is calculation done
    /// @param _sportId for which is calculation done
    /// @param _typeId for which is calculation done
    /// @param _playerId for which is calculation done
    /// @param _line for which is calculation done
    /// @param _maturity used for dynamic liquidity check
    /// @return isNotRisky true/false
    function isTotalSpendingLessThanTotalRisk(
        uint _totalSpent,
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _maturity
    ) external view returns (bool isNotRisky) {
        uint capToBeUsed = _calculateCapToBeUsed(_gameId, _sportId, _typeId, _playerId, _line, _maturity);
        uint riskMultiplier = _calculateRiskMultiplier(_gameId, _sportId, _typeId, _playerId, _line);
        return _totalSpent <= capToBeUsed * riskMultiplier;
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

    /* ========== INTERNALS ========== */

    function _calculateRiskMultiplier(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line
    ) internal view returns (uint marketRisk) {
        marketRisk = riskMultiplierPerMarket[_gameId][_typeId][_playerId][_line];

        if (marketRisk == 0) {
            uint riskPerSport = riskMultiplierPerSport[_sportId];
            marketRisk = riskPerSport > 0 ? riskPerSport : defaultRiskMultiplier;
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

    /* ========== SETTERS ========== */

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

    /// @notice sets the risk multiplier per spec. markets
    /// @param _gameIds game IDs to set risk multiplier for
    /// @param _typeIds type IDs to set risk multiplier for
    /// @param _playerIds player IDs to set risk multiplier for
    /// @param _lines lines to set risk multiplier for
    /// @param _riskMultipliersPerMarket the risk multiplier amounts used for the specific markets
    function setRiskMultipliersPerMarket(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint16[] memory _playerIds,
        int24[] memory _lines,
        uint[] memory _riskMultipliersPerMarket
    ) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _gameIds.length; i++) {
            require(_riskMultipliersPerMarket[i] <= maxRiskMultiplier, "Invalid multiplier");
            riskMultiplierPerMarket[_gameIds[i]][_typeIds[i]][_playerIds[i]][_lines[i]] = _riskMultipliersPerMarket[i];
            emit SetRiskMultiplierPerMarket(
                _gameIds[i],
                _typeIds[i],
                _playerIds[i],
                _lines[i],
                _riskMultipliersPerMarket[i]
            );
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

    /// @notice Setting whether live trading per sport is enabled
    /// @param _sportId to set live trading for
    /// @param _typeId to set live trading for
    /// @param _enabled self explanatory
    function setLiveTradingPerSportAndTypeEnabled(uint _sportId, uint _typeId, bool _enabled) external onlyOwner {
        liveTradingPerSportAndTypeEnabled[_sportId][_typeId] = _enabled;
        emit SetLiveTradingPerSportAndTypeEnabled(_sportId, _typeId, _enabled);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

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

    /* ========== EVENTS ========== */

    event SetMaxCapAndMaxRiskMultiplier(uint maxCap, uint maxRiskMultiplier);
    event SetDefaultCapAndDefaultRiskMultiplier(uint defaultCap, uint defaultRiskMultiplier);

    event SetCapPerSport(uint sportId, uint cap);
    event SetCapPerSportChild(uint sportId, uint cap);
    event SetCapPerSportAndType(uint sportId, uint typeId, uint cap);
    event SetCapPerMarket(bytes32 gameId, uint16 typeId, uint16 playerId, int24 line, uint cap);

    event SetRiskMultiplierPerSport(uint sportId, uint riskMultiplier);
    event SetRiskMultiplierPerMarket(bytes32 gameId, uint16 typeId, uint16 playerId, int24 line, uint riskMultiplier);

    event SetDynamicLiquidityParams(uint sportId, uint dynamicLiquidityCutoffTime, uint dynamicLiquidityCutoffDivider);
    event SetSportsManager(address manager);
    event SetLiveTradingPerSportAndTypeEnabled(uint _sportId, uint _typeId, bool _enabled);
}
