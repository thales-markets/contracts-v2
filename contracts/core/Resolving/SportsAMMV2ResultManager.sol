// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// internal
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../utils/libraries/AddressSetLib.sol";

import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";

import "../AMM//Ticket.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";
import "../../interfaces/ISportsAMMV2LiquidityPool.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2ResultManager is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    enum ResultType {
        Unassigned,
        ExactPosition,
        OverUnder,
        CombinedPositions,
        Spread
    }

    enum OverUnderType {
        Over,
        Under
    }

    /* ========== CONST VARIABLES ========== */

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;

    int24 public constant CANCEL_ID = -9999;

    /* ========== STATE VARIABLES ========== */

    // manager address
    ISportsAMMV2Manager public manager;

    // stores market results, market defined with gameId -> typeId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => int24[]))) public resultsPerMarket;

    // indicates are results set for market, market defined with gameId -> typeId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => bool))) public areResultsPerMarketSet;

    // indicates is game cancelled (parent market together with all child markets)
    mapping(bytes32 => bool) public isGameCancelled;

    // indicates is market explicitly cancelled, market defined with gameId -> typeId -> playerId -> line
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(int => bool)))) public isMarketExplicitlyCancelled;

    // stores result type per market type
    mapping(uint => ResultType) public resultTypePerMarketType;

    // the address that can resolve markets
    address public chainlinkResolver;

    // number of tickets to exercise on game resolution
    uint public numOfTicketsToExerciseOnGameResolution;

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
        uint24 _playerId,
        int24 _line,
        ISportsAMMV2.CombinedPosition[] memory combinedPositions
    ) external view returns (bool isResolved) {
        if (isGameCancelled[_gameId]) {
            isResolved = true;
        } else {
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
        }
    }

    /// @notice is specific market cancelled
    /// @param _gameId game ID
    /// @param _typeId type ID
    /// @param _playerId player ID (0 if not player props game)
    /// @param _line line
    /// @return isCancelled true/false
    function isMarketCancelled(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        ISportsAMMV2.CombinedPosition[] memory combinedPositions
    ) external view returns (bool isCancelled) {
        if (isGameCancelled[_gameId]) {
            isCancelled = true;
        } else {
            ResultType resultType = resultTypePerMarketType[_typeId];
            if (resultType == ResultType.CombinedPositions) {
                isCancelled = true;
                for (uint i = 0; i < combinedPositions.length; i++) {
                    ISportsAMMV2.CombinedPosition memory combinedPosition = combinedPositions[i];
                    bool isCombinedPositionMarketCancelled = _isMarketCancelled(
                        _gameId,
                        combinedPosition.typeId,
                        0,
                        combinedPosition.line
                    );
                    if (!isCombinedPositionMarketCancelled) {
                        isCancelled = false;
                        break;
                    }
                }
            } else {
                isCancelled = _isMarketCancelled(_gameId, _typeId, _playerId, _line);
            }
        }
    }

    function getMarketPositionStatus(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line,
        uint _position,
        ISportsAMMV2.CombinedPosition[] memory _combinedPositions
    ) external view returns (ISportsAMMV2ResultManager.MarketPositionStatus status) {
        return _getMarketPositionStatus(_gameId, _typeId, _playerId, _line, _position, _combinedPositions);
    }

    function isWinningMarketPosition(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
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
        uint24 _playerId,
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
        uint24 _playerId
    ) external view returns (int24[] memory results) {
        return resultsPerMarket[_gameId][_typeId][_playerId];
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice set result for specific markets and exercise losing tickets (up to numOfTicketsToExerciseOnGameResolution)
    /// @param _gameIds game IDs to set results for
    /// @param _typeIds type IDs to set results for
    /// @param _playerIds player IDs to set results for
    /// @param _results market results
    function setResultsPerMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds,
        int24[][] memory _results
    ) external onlyWhitelistedAddresses(msg.sender) {
        require(
            _gameIds.length == _typeIds.length &&
                _typeIds.length == _playerIds.length &&
                _playerIds.length == _results.length,
            "Incorrect params"
        );
        uint numOfTicketsToExercise = numOfTicketsToExerciseOnGameResolution;
        for (uint i; i < _gameIds.length; i++) {
            bytes32 gameId = _gameIds[i];
            //skip cancelled games
            if (isGameCancelled[gameId]) {
                continue;
            }

            uint16 typeId = _typeIds[i];
            uint24 playerId = _playerIds[i];
            int24[] memory results = _results[i];
            if (results[0] == CANCEL_ID) {
                if (numOfTicketsToExercise > 0) {
                    address[] memory activeTickets = manager.getActiveTicketsPerMarket(0, 100, gameId, typeId, playerId);
                    numOfTicketsToExercise = _exerciseLosingTickets(activeTickets, numOfTicketsToExercise);
                }
                _cancelMarket(gameId, typeId, playerId, 0);
            } else {
                ResultType resultType = resultTypePerMarketType[typeId];
                require(resultType != ResultType.Unassigned, "Result type not set");
                if (!areResultsPerMarketSet[gameId][typeId][playerId]) {
                    resultsPerMarket[gameId][typeId][playerId] = results;
                    areResultsPerMarketSet[gameId][typeId][playerId] = true;
                    if (numOfTicketsToExercise > 0) {
                        address[] memory activeTickets = manager.getActiveTicketsPerMarket(0, 100, gameId, typeId, playerId);
                        numOfTicketsToExercise = _exerciseLosingTickets(activeTickets, numOfTicketsToExercise);
                    }
                    emit ResultsPerMarketSet(gameId, typeId, playerId, results);
                }
            }
        }
    }

    /// @notice cancel specific games
    /// @param _gameIds game IDs to cancel
    function cancelGames(bytes32[] memory _gameIds) external onlyWhitelistedAddresses(msg.sender) {
        for (uint i; i < _gameIds.length; i++) {
            bytes32 gameId = _gameIds[i];
            _cancelGame(gameId);
        }
    }

    /// @notice cancel specific game
    /// @param _gameId game ID to cancel
    function cancelGame(bytes32 _gameId) external onlyWhitelistedAddresses(msg.sender) {
        _cancelGame(_gameId);
    }

    function _cancelGame(bytes32 _gameId) internal {
        require(!isGameCancelled[_gameId], "Game already cancelled");
        isGameCancelled[_gameId] = true;
        emit GameCancelled(_gameId);
    }

    /// @notice cancel specific markets
    /// @param _gameIds game IDs to cancel
    /// @param _typeIds type IDs to cancel
    /// @param _playerIds player IDs to cancel
    function cancelMarkets(
        bytes32[] memory _gameIds,
        uint16[] memory _typeIds,
        uint24[] memory _playerIds,
        int24[] memory _lines
    ) external onlyWhitelistedAddresses(msg.sender) {
        require(
            _gameIds.length == _typeIds.length && _typeIds.length == _playerIds.length && _playerIds.length == _lines.length,
            "Incorrect params"
        );
        for (uint i; i < _gameIds.length; i++) {
            bytes32 gameId = _gameIds[i];
            uint16 typeId = _typeIds[i];
            uint24 playerId = _playerIds[i];
            int24 line = _lines[i];
            _cancelMarket(gameId, typeId, playerId, line);
        }
    }

    /// @notice cancel specific markets
    /// @param _gameId game ID to cancel
    /// @param _typeId type ID to cancel
    /// @param _playerId player ID to cancel
    /// @param _line player ID to cancel
    function cancelMarket(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line
    ) external onlyWhitelistedAddresses(msg.sender) {
        _cancelMarket(_gameId, _typeId, _playerId, _line);
    }

    /// @notice cancel specific markets
    /// @param _gameId game ID to cancel
    /// @param _typeId type ID to cancel
    /// @param _playerId player IDs to cancel
    function _cancelMarket(bytes32 _gameId, uint16 _typeId, uint24 _playerId, int24 _line) internal {
        require(!_isMarketCancelled(_gameId, _typeId, _playerId, _line), "Market already cancelled");
        isMarketExplicitlyCancelled[_gameId][_typeId][_playerId][_line] = true;
        emit MarketExplicitlyCancelled(_gameId, _typeId, _playerId, _line);
    }

    /// @notice set result types for specific markets
    /// @param _marketTypeIds market type IDs to set result type for
    /// @param _resultTypes result types to set
    function setResultTypesPerMarketTypes(uint16[] memory _marketTypeIds, uint[] memory _resultTypes) external onlyOwner {
        require(_marketTypeIds.length == _resultTypes.length, "Incorrect params");
        for (uint i; i < _marketTypeIds.length; i++) {
            uint16 marketTypeId = _marketTypeIds[i];
            uint resultType = _resultTypes[i];

            require(
                resultType > uint(ResultType.Unassigned) && resultType <= uint(ResultType.Spread),
                "Invalid result type"
            );
            resultTypePerMarketType[marketTypeId] = ResultType(resultType);
            emit ResultTypePerMarketTypeSet(marketTypeId, resultType);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _isMarketResolved(bytes32 _gameId, uint16 _typeId, uint24 _playerId, int24 _line) internal view returns (bool) {
        return areResultsPerMarketSet[_gameId][_typeId][_playerId] || _isMarketCancelled(_gameId, _typeId, _playerId, _line);
    }

    function _isMarketCancelled(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
        int24 _line
    ) internal view returns (bool) {
        return
            isGameCancelled[_gameId] ||
            isMarketExplicitlyCancelled[_gameId][_typeId][_playerId][_line] ||
            isMarketExplicitlyCancelled[_gameId][_typeId][_playerId][0];
    }

    function _getMarketPositionStatus(
        bytes32 _gameId,
        uint16 _typeId,
        uint24 _playerId,
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
        uint24 _playerId,
        int24 _line,
        uint position
    ) internal view returns (ISportsAMMV2ResultManager.MarketPositionStatus status) {
        if (_isMarketCancelled(_gameId, _typeId, _playerId, _line)) {
            return ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
        }

        if (areResultsPerMarketSet[_gameId][_typeId][_playerId]) {
            int24[] memory marketResults = resultsPerMarket[_gameId][_typeId][_playerId];
            ResultType resultType = resultTypePerMarketType[_typeId];

            for (uint i = 0; i < marketResults.length; i++) {
                int marketResult = marketResults[i];
                if (resultType == ResultType.OverUnder || resultType == ResultType.Spread) {
                    if (marketResult == _line) {
                        return ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
                    } else {
                        OverUnderType winningPosition = resultType == ResultType.Spread
                            ? (marketResult < _line ? OverUnderType.Over : OverUnderType.Under)
                            : (marketResult > _line ? OverUnderType.Over : OverUnderType.Under);
                        if (uint(winningPosition) == position) {
                            return ISportsAMMV2ResultManager.MarketPositionStatus.Winning;
                        }
                    }
                } else {
                    if (marketResult == int(position)) {
                        return ISportsAMMV2ResultManager.MarketPositionStatus.Winning;
                    }
                }
            }

            return ISportsAMMV2ResultManager.MarketPositionStatus.Losing;
        }

        return ISportsAMMV2ResultManager.MarketPositionStatus.Open;
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
            if (!hasCancelledPosition) {
                hasCancelledPosition = combinedPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Cancelled;
            }
            if (!hasOpenPosition) {
                hasOpenPosition = combinedPositionStatus == ISportsAMMV2ResultManager.MarketPositionStatus.Open;
            }
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

    function _exerciseLosingTickets(address[] memory _tickets, uint _numOfTicketsToExercise) internal returns (uint) {
        ISportsAMMV2 sportsAMM = ISportsAMMV2(manager.sportsAMM());
        for (uint i; i < _tickets.length; i++) {
            Ticket ticket = Ticket(_tickets[i]);
            if (ticket.isTicketExercisable() && !ticket.isUserTheWinner()) {
                sportsAMM.exerciseTicket(address(ticket));
                _numOfTicketsToExercise--;
            }
            if (_numOfTicketsToExercise == 0) {
                return _numOfTicketsToExercise;
            }
        }
        return _numOfTicketsToExercise;
    }

    modifier onlyWhitelistedAddresses(address sender) {
        require(
            sender == owner ||
                sender == chainlinkResolver ||
                manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING),
            "Invalid sender"
        );
        _;
    }

    /* ========== SETTERS ========== */

    /// @notice sets the sports manager contract address
    /// @param _manager the address of sports manager contract
    function setSportsManager(address _manager) external onlyOwner {
        require(_manager != address(0), "Invalid address");
        manager = ISportsAMMV2Manager(_manager);
        emit SetSportsManager(_manager);
    }

    /// @notice sets the address of a contract that can resolve markets via chainlink node
    /// @param _chainlinkResolver the address of chainlink node client
    function setChainlinkResolver(address _chainlinkResolver) external onlyOwner {
        require(_chainlinkResolver != address(0), "Invalid address");
        chainlinkResolver = _chainlinkResolver;
        emit SetChainlinkResolver(_chainlinkResolver);
    }

    /// @notice sets the number of tickets to automatically exercise when resolving games
    /// @param _numOfTicketsToExercise the maximum number of tickets to exercise per game resolution
    function setNumOfTicketsToExerciseOnGameResolution(uint _numOfTicketsToExercise) external onlyOwner {
        numOfTicketsToExerciseOnGameResolution = _numOfTicketsToExercise;
        emit SetNumOfTicketsToExerciseOnGameResolution(_numOfTicketsToExercise);
    }

    /* ========== EVENTS ========== */

    event ResultsPerMarketSet(bytes32 gameId, uint16 typeId, uint24 playerId, int24[] result);
    event GameCancelled(bytes32 gameId);
    event MarketExplicitlyCancelled(bytes32 gameId, uint16 typeId, uint24 playerId, int24 line);
    event ResultTypePerMarketTypeSet(uint16 marketTypeId, uint resultType);

    event SetSportsManager(address manager);
    event SetChainlinkResolver(address resolver);
    event SetNumOfTicketsToExerciseOnGameResolution(uint numOfTicketsToExercise);
}
