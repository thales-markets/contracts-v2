// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../utils/libraries/AddressSetLib.sol";

import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";

import "./Ticket.sol";
import "../interfaces/ISportsAMMV2.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2ResultManager.sol";
import "../interfaces/ISportsAMMV2LiquidityPool.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2ResultManager is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    enum ResultType {
        ExactPosition,
        OverUnder,
        CombinedPositions
    }

    /* ========== CONST VARIABLES ========== */

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;

    uint public constant TYPE_ID_SPREAD = 10001;

    /* ========== STATE VARIABLES ========== */

    // manager address
    ISportsAMMV2Manager public manager;

    // stores market results, market defined with gameId -> typeId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => int24[]))) public resultsPerMarket;

    // indicates are results set for market, market defined with gameId -> typeId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => bool))) public areResultsPerMarketSet;

    // indicates is market explicitly cancelled, market defined with gameId -> typeId -> playerId -> line
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(int => bool)))) public isMarketCancelled;

    // stores result type per market type
    mapping(uint => ResultType) public resultTypePerMarketType;

    /* ========== CONSTRUCTOR ========== */

    /// @param _manager the address of manager
    function initialize(address _owner, ISportsAMMV2Manager _manager) public initializer {
        setOwner(_owner);
        initNonReentrant();
        manager = _manager;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice is specific market resolved
    /// @param _gameId game ID
    /// @param _typeId type ID
    /// @param _playerId player ID (0 if not player props game)
    /// @param _line line
    /// @return isResolved true/false
    function isMarketResolved(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        ISportsAMMV2.CombinedPosition[] memory combinedPositions
    ) external view returns (bool isResolved) {
        ResultType resultType = resultTypePerMarketType[_typeId];
        if (resultType == ResultType.CombinedPositions) {
            isResolved = true;
            for (uint i = 0; i < combinedPositions.length; i++) {
                ISportsAMMV2.CombinedPosition memory combinedPosition = combinedPositions[i];
                bool isCombinedPositionMarketResolved = _isMarketResolved(
                    _gameId,
                    combinedPosition.typeId,
                    0,
                    combinedPosition.line
                );
                if (!isCombinedPositionMarketResolved) {
                    isResolved = false;
                    break;
                }
            }
        } else {
            isResolved = _isMarketResolved(_gameId, _typeId, _playerId, _line);
        }
        return isResolved;
    }

    function getMarketPositionStatus(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (ISportsAMMV2ResultManager.MarketPositionStatus status) {
        return _getMarketPositionStatus(_gameId, _typeId, _playerId, _line, _position, _combinedPositions);
    }

    function isWinningMarketPosition(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (bool isWinning) {
        ISportsAMMV2ResultManager.MarketPositionStatus marketPositionStatus = _getMarketPositionStatus(
            _gameId,
            _typeId,
            _playerId,
            _line,
            _position,
            _combinedPositions
        );
        return
            marketPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Winning ||
            marketPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
    }

    function isCancelledMarketPosition(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (bool isCancelled) {
        ISportsAMMV2ResultManager.MarketPositionStatus marketPositionStatus = _getMarketPositionStatus(
            _gameId,
            _typeId,
            _playerId,
            _line,
            _position,
            _combinedPositions
        );
        return marketPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
    }

    function getResultsPerMarket(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId
    ) external view returns (int24[] memory results) {
        return resultsPerMarket[_gameId][_typeId][_playerId];
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice set result for specific markets
    /// @param _gameIds markets results data
    function setResultsPerMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint16[] memory _playerIds,
        int24[][] memory _results
    ) external onlyOwner {
        for (uint i; i < _gameIds.length; i++) {
            bytes32 gameId = _gameIds[i];
            uint16 typeId = _typeIds[i];
            uint16 playerId = _playerIds[i];
            int24[] memory result = _results[i];

            require(!areResultsPerMarketSet[gameId][typeId][playerId], "Results already set per market");

            resultsPerMarket[gameId][typeId][playerId] = result;
            areResultsPerMarketSet[gameId][typeId][playerId] = true;
            emit ResultPerMarketSet(gameId, typeId, playerId, result);
        }
    }

    /// @notice cancel specific markets
    /// @param _gameIds markets cancel data
    function cancelMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint16[] memory _playerIds,
        int24[] memory _lines
    ) external onlyOwner {
        for (uint i; i < _gameIds.length; i++) {
            bytes32 gameId = _gameIds[i];
            uint16 typeId = _typeIds[i];
            uint16 playerId = _playerIds[i];
            int24 line = _lines[i];

            require(!isMarketCancelled[gameId][typeId][playerId][line], "Market already cancelled");
            isMarketCancelled[gameId][typeId][playerId][line] = true;
            emit MarketCancelled(gameId, typeId, playerId, line);
        }
    }

    /// @notice set result for specific markets
    /// @param _marketTypeIds markets results data
    function setResultTypesPerMarketTypes(
        uint16[] memory _marketTypeIds,
        ResultType[] memory _resultTypes
    ) external onlyOwner {
        for (uint i; i < _marketTypeIds.length; i++) {
            uint16 marketTypeId = _marketTypeIds[i];
            ResultType resultType = _resultTypes[i];

            resultTypePerMarketType[marketTypeId] = resultType;
            emit ResultTypePerMarketTypeSet(marketTypeId, resultType);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _isMarketResolved(bytes32 _gameId, uint16 _typeId, uint16 _playerId, int24 _line) internal view returns (bool) {
        return areResultsPerMarketSet[_gameId][_typeId][_playerId] || isMarketCancelled[_gameId][_typeId][_playerId][_line];
    }

    function _getMarketPositionStatus(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint position,
        ISportsAMMV2.CombinedPosition[] memory combinedPositions
    ) internal view returns (ISportsAMMV2ResultManager.MarketPositionStatus status) {
        ResultType resultType = resultTypePerMarketType[_typeId];
        return
            resultType == ResultType.CombinedPositions
                ? _getMarketCombinedPositionsStatus(_gameId, combinedPositions)
                : _getMarketSinglePositionStatus(_gameId, _typeId, _playerId, _line, position);
    }

    function _getMarketSinglePositionStatus(
        bytes32 _gameId,
        uint16 _typeId,
        uint16 _playerId,
        int24 _line,
        uint position
    ) internal view returns (ISportsAMMV2ResultManager.MarketPositionStatus status) {
        if (isMarketCancelled[_gameId][_typeId][_playerId][_line]) {
            return ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
        }
        if (!areResultsPerMarketSet[_gameId][_typeId][_playerId]) {
            return ISportsAMMV2ResultManager.MarketPositionStatus.Open;
        }

        int24[] memory marketResults = resultsPerMarket[_gameId][_typeId][_playerId];
        ResultType resultType = resultTypePerMarketType[_typeId];

        bool isWinning = false;

        for (uint i = 0; i < marketResults.length; i++) {
            int marketResult = marketResults[i];
            if (resultType == ResultType.ExactPosition) {
                if (marketResult == int(position)) {
                    isWinning = true;
                    break;
                }
            } else if (resultType == ResultType.OverUnder) {
                if (marketResult == _line) {
                    return ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
                } else {
                    uint winningPosition = _typeId == TYPE_ID_SPREAD
                        ? (marketResult < _line ? 0 : 1)
                        : (marketResult > _line ? 0 : 1);
                    if (winningPosition == position) {
                        isWinning = true;
                        break;
                    }
                }
            }
        }

        return
            isWinning
                ? ISportsAMMV2ResultManager.MarketPositionStatus.Winning
                : ISportsAMMV2ResultManager.MarketPositionStatus.Losing;
    }

    function _getMarketCombinedPositionsStatus(
        bytes32 _gameId,
        ISportsAMMV2.CombinedPosition[] memory combinedPositions
    ) internal view returns (ISportsAMMV2ResultManager.MarketPositionStatus status) {
        bool hasCancelledPosition = false;
        bool hasOpenPosition = false;

        for (uint i = 0; i < combinedPositions.length; i++) {
            ISportsAMMV2.CombinedPosition memory combinedPosition = combinedPositions[i];
            ISportsAMMV2ResultManager.MarketPositionStatus combinedPositionStatus = _getMarketSinglePositionStatus(
                _gameId,
                combinedPosition.typeId,
                0,
                combinedPosition.line,
                combinedPosition.position
            );
            if (combinedPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Losing) {
                return ISportsAMMV2ResultManager.MarketPositionStatus.Losing;
            }
            hasCancelledPosition = combinedPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
            hasOpenPosition = combinedPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Open;
        }

        return
            hasCancelledPosition
                ? ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled
                : (
                    hasOpenPosition
                        ? ISportsAMMV2ResultManager.MarketPositionStatus.Open
                        : ISportsAMMV2ResultManager.MarketPositionStatus.Winning
                );
    }

    /* ========== EVENTS ========== */

    event ResultPerMarketSet(bytes32 gameId, uint16 typeId, uint16 playerId, int24[] result);
    event MarketCancelled(bytes32 gameId, uint16 typeId, uint16 playerId, int24 line);
    event ResultTypePerMarketTypeSet(uint16 marketTypeId, ResultType resultType);
}
