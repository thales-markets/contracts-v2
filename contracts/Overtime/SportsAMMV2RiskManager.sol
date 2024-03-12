// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";

import "../interfaces/ISportsAMMV2Manager.sol";

/// @title Sports AMM V2 Risk Manager contract
/// @author vladan
contract SportsAMMV2RiskManager is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== CONST VARIABLES ========== */

    uint public constant MIN_SPORT_NUMBER = 9000;
    uint public constant MIN_TYPE_NUMBER = 10000;
    uint public constant DEFAULT_DYNAMIC_LIQUIDITY_CUTOFF_DIVIDER = 2e18;
    uint private constant ONE = 1e18;

    /* ========== STATE VARIABLES ========== */

    ISportsAMMV2Manager public manager;
    uint public defaultCap;
    mapping(uint => uint) public capPerSport;
    mapping(uint => mapping(uint => uint)) public capPerSportAndType;
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => mapping(int => uint))))) public capPerMarket;

    uint public defaultRiskMultiplier;
    mapping(uint => uint) public riskMultiplierPerSport;
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => mapping(int => uint)))))
        public riskMultiplierPerMarket;

    uint public maxCap;
    uint public maxRiskMultiplier;

    mapping(uint => uint) public dynamicLiquidityCutoffTimePerSport;
    mapping(uint => uint) public dynamicLiquidityCutoffDividerPerSport;

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
    /// @return _isNotRisky true/false
    function isTotalSpendingLessThanTotalRisk(
        uint _totalSpent,
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _maturity
    ) external view returns (bool _isNotRisky) {
        uint capToBeUsed = _calculateCapToBeUsed(_gameId, _sportId, _typeId, _playerId, _line, _maturity);
        uint riskMultiplier = _calculateRiskMultiplier(_gameId, _sportId, _typeId, _playerId, _line);
        return _totalSpent <= capToBeUsed * riskMultiplier;
    }

    /// @notice returns all data (caps) for given sports
    /// @param _sportIds sport ids
    /// @return capsPerSport caps per sport
    /// @return capsPerSportH caps per type Handicap
    /// @return capsPerSportT caps per type Total
    function getAllDataForSports(
        uint[] memory _sportIds
    ) external view returns (uint[] memory capsPerSport, uint[] memory capsPerSportH, uint[] memory capsPerSportT) {
        capsPerSport = new uint[](_sportIds.length);
        capsPerSportH = new uint[](_sportIds.length);
        capsPerSportT = new uint[](_sportIds.length);

        for (uint i = 0; i < _sportIds.length; i++) {
            capsPerSport[i] = capPerSport[_sportIds[i]];
            capsPerSportH[i] = capPerSportAndType[_sportIds[i]][MIN_TYPE_NUMBER + 1];
            capsPerSportT[i] = capPerSportAndType[_sportIds[i]][MIN_TYPE_NUMBER + 2];
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
        marketRisk = riskMultiplierPerMarket[_gameId][_sportId][_typeId][_playerId][_line];

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
            cap = capPerMarket[_gameId][_sportId][_typeId][_playerId][_line];
            if (cap == 0) {
                uint sportCap = capPerSport[_sportId];
                sportCap = sportCap > 0 ? sportCap : defaultCap;
                cap = sportCap;

                if (_typeId > 0) {
                    uint typeCap = capPerSportAndType[_sportId][_typeId];
                    cap = typeCap > 0 ? typeCap : sportCap / 2;
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

    /// @notice Setting the Cap default value
    /// @param _defaultCap default cap
    function setDefaultCap(uint _defaultCap) external onlyOwner {
        require(_defaultCap <= maxCap, "Invalid cap");
        defaultCap = _defaultCap;
        emit SetDefaultCap(_defaultCap);
    }

    /// @notice Setting the Cap per Sport
    /// @param _sportId The ID used for sport
    /// @param _capPerSport The cap amount used for the Sport ID
    function setCapPerSport(uint _sportId, uint _capPerSport) external onlyOwner {
        _setCapPerSport(_sportId, _capPerSport);
    }

    /// @notice Setting the Cap per Sport and Type
    /// @param _sportId The ID used for sport
    /// @param _typeId The ID used for type
    /// @param _capPerType The cap amount used for the Sport ID and Type ID
    function setCapPerSportAndType(uint _sportId, uint _typeId, uint _capPerType) external onlyOwner {
        _setCapPerSportAndType(_sportId, _typeId, _capPerType);
    }

    /// @notice Setting the Cap per spec. markets
    /// @param _gameIds game Ids to set cap for
    /// @param _sportIds sport Ids to set cap for
    /// @param _typeIds type Ids to set cap for
    /// @param _playerIds player Ids to set cap for
    /// @param _lines lines to set cap for
    /// @param _capPerMarket The cap amount used for the specific markets
    function setCapPerMarket(
        bytes32[] memory _gameIds,
        uint16[] memory _sportIds,
        uint16[] memory _typeIds,
        uint16[] memory _playerIds,
        int24[] memory _lines,
        uint _capPerMarket
    ) external {
        require(msg.sender == owner || manager.isWhitelistedAddress(msg.sender), "Invalid sender");
        require(_capPerMarket <= maxCap, "Invalid cap");
        for (uint i; i < _gameIds.length; i++) {
            capPerMarket[_gameIds[i]][_sportIds[i]][_typeIds[i]][_playerIds[i]][_lines[i]] = _capPerMarket;
            emit SetCapPerMarket(_gameIds[i], _sportIds[i], _typeIds[i], _playerIds[i], _lines[i], _capPerMarket);
        }
    }

    /// @notice Setting the Cap per Sport and Cap per Sport and Type (batch)
    /// @param _sportIds sport Ids to set cap for
    /// @param _capsPerSport the cap amounts used for the Sport IDs
    /// @param _sportIdsForTypes sport Ids to set type cap for
    /// @param _typeIds type Ids to set cap for
    /// @param _capsPerSportAndType the cap amounts used for the Sport IDs and Type IDs
    function setCaps(
        uint[] memory _sportIds,
        uint[] memory _capsPerSport,
        uint[] memory _sportIdsForTypes,
        uint[] memory _typeIds,
        uint[] memory _capsPerSportAndType
    ) external onlyOwner {
        for (uint i; i < _sportIds.length; i++) {
            _setCapPerSport(_sportIds[i], _capsPerSport[i]);
        }
        for (uint i; i < _sportIdsForTypes.length; i++) {
            _setCapPerSportAndType(_sportIdsForTypes[i], _typeIds[i], _capsPerSportAndType[i]);
        }
    }

    /// @notice Setting default risk multiplier
    /// @param _defaultRiskMultiplier default risk multiplier
    function setDefaultRiskMultiplier(uint _defaultRiskMultiplier) external onlyOwner {
        require(_defaultRiskMultiplier <= maxRiskMultiplier, "Invalid multiplier");
        defaultRiskMultiplier = _defaultRiskMultiplier;
        emit SetDefaultRiskMultiplier(_defaultRiskMultiplier);
    }

    /// @notice Setting the risk multiplier per Sport
    /// @param _sportId The ID used for sport
    /// @param _riskMultiplier The risk multiplier amount used for the Sport ID
    function setRiskMultiplierPerSport(uint _sportId, uint _riskMultiplier) external onlyOwner {
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        require(_riskMultiplier <= maxRiskMultiplier, "Invalid multiplier");
        riskMultiplierPerSport[_sportId] = _riskMultiplier;
        emit SetRiskMultiplierPerSport(_sportId, _riskMultiplier);
    }

    /// @notice Setting the risk multiplier per spec. markets
    /// @param _gameIds game Ids to set risk multiplier for
    /// @param _sportIds sport Ids to set risk multiplier for
    /// @param _typeIds type Ids to set risk multiplier for
    /// @param _playerIds player Ids to set risk multiplier for
    /// @param _lines lines to set risk multiplier for
    /// @param _riskMultiplierPerMarket The risk multiplier amount used for the specific markets
    function setRiskMultiplierPerMarket(
        bytes32[] memory _gameIds,
        uint16[] memory _sportIds,
        uint16[] memory _typeIds,
        uint16[] memory _playerIds,
        int24[] memory _lines,
        uint _riskMultiplierPerMarket
    ) external {
        require(msg.sender == owner || manager.isWhitelistedAddress(msg.sender), "Invalid sender");
        require(_riskMultiplierPerMarket <= maxRiskMultiplier, "Invalid multiplier");
        for (uint i; i < _gameIds.length; i++) {
            riskMultiplierPerMarket[_gameIds[i]][_sportIds[i]][_typeIds[i]][_playerIds[i]][
                _lines[i]
            ] = _riskMultiplierPerMarket;
            emit SetRiskMultiplierPerMarket(
                _gameIds[i],
                _sportIds[i],
                _typeIds[i],
                _playerIds[i],
                _lines[i],
                _riskMultiplierPerMarket
            );
        }
    }

    /// @notice Setting the risk multiplier per Sport (batch)
    /// @param _sportIds sport Ids to set risk multiplier for
    /// @param _riskMultiplierPerSport the risk multiplier amounts used for the Sport IDs
    function setRiskMultipliers(uint[] memory _sportIds, uint[] memory _riskMultiplierPerSport) external onlyOwner {
        for (uint i; i < _sportIds.length; i++) {
            require(_sportIds[i] > MIN_SPORT_NUMBER, "Invalid ID for sport");
            require(_riskMultiplierPerSport[i] <= maxRiskMultiplier, "Invalid multiplier");
            riskMultiplierPerSport[_sportIds[i]] = _riskMultiplierPerSport[i];
            emit SetRiskMultiplierPerSport(_sportIds[i], _riskMultiplierPerSport[i]);
        }
    }

    /// @notice Setting the max cap and max risk per game
    /// @param _maxCap max cap
    /// @param _maxRisk max risk multiplier
    function setMaxCapAndRisk(uint _maxCap, uint _maxRisk) external onlyOwner {
        require(_maxCap > defaultCap && _maxRisk > defaultRiskMultiplier, "Invalid input");
        maxCap = _maxCap;
        maxRiskMultiplier = _maxRisk;
        emit SetMaxCapAndRisk(_maxCap, _maxRisk);
    }

    function _setCapPerSport(uint _sportId, uint _capPerSport) internal {
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        require(_capPerSport <= maxCap, "Invalid cap");
        capPerSport[_sportId] = _capPerSport;
        emit SetCapPerSport(_sportId, _capPerSport);
    }

    function _setCapPerSportAndType(uint _sportId, uint _typeId, uint _capPerType) internal {
        uint currentCapPerSport = capPerSport[_sportId] > 0 ? capPerSport[_sportId] : defaultCap;
        require(_capPerType <= currentCapPerSport, "Invalid cap");
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        require(_typeId > MIN_TYPE_NUMBER, "Invalid ID for type");
        capPerSportAndType[_sportId][_typeId] = _capPerType;
        emit SetCapPerSportAndType(_sportId, _typeId, _capPerType);
    }

    /// @notice Setting the dynamic liquidity params
    /// @param _sportId The ID used for sport
    /// @param _dynamicLiquidityCutoffTime when to start increasing the liquidity linearly, if 0 assume 100% liquidity all the time since game creation
    /// @param _dynamicLiquidityCutoffDivider e.g. if 2 it means liquidity up until cut off time is 50%, then increases linearly. if 0 use default
    function setDynamicLiquidityParamsPerSport(
        uint _sportId,
        uint _dynamicLiquidityCutoffTime,
        uint _dynamicLiquidityCutoffDivider
    ) external onlyOwner {
        require(_sportId > MIN_SPORT_NUMBER, "Invalid ID for sport");
        dynamicLiquidityCutoffTimePerSport[_sportId] = _dynamicLiquidityCutoffTime;
        dynamicLiquidityCutoffDividerPerSport[_sportId] = _dynamicLiquidityCutoffDivider;
        emit SetDynamicLiquidityParams(_sportId, _dynamicLiquidityCutoffTime, _dynamicLiquidityCutoffDivider);
    }

    /// @notice Setting the Sports Manager contract address
    /// @param _manager Address of Sports Manager contract
    function setSportsManager(address _manager) external onlyOwner {
        require(_manager != address(0), "Invalid address");
        manager = ISportsAMMV2Manager(_manager);
        emit SetSportsManager(_manager);
    }

    /* ========== EVENTS ========== */

    event SetDefaultCap(uint cap);
    event SetCapPerSport(uint sportId, uint cap);
    event SetCapPerSportAndType(uint sportId, uint typeId, uint cap);
    event SetCapPerMarket(bytes32 gameId, uint16 sportId, uint16 typeId, uint16 playerId, int24 line, uint cap);

    event SetDefaultRiskMultiplier(uint riskMultiplier);
    event SetRiskMultiplierPerSport(uint sportId, uint riskMultiplier);
    event SetRiskMultiplierPerMarket(
        bytes32 gameId,
        uint16 sportId,
        uint16 typeId,
        uint16 playerId,
        int24 line,
        uint riskMultiplier
    );
    event SetMaxCapAndRisk(uint maxCap, uint maxRisk);

    event SetDynamicLiquidityParams(uint sportId, uint dynamicLiquidityCutoffTime, uint dynamicLiquidityCutoffDivider);
    event SetSportsManager(address manager);
}
