// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../utils/proxy/ProxyReentrancyGuard.sol";

import "../../interfaces/ISportsAMMV2Data.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "./../AMM/Ticket.sol";

contract ResolveBlocker is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /// @notice The interface for accessing sports AMM data
    ISportsAMMV2Data public sportsAMMData;

    /// @notice The interface for the sports AMM manager
    ISportsAMMV2Manager public manager;

    /// @notice Mapping to track if a game is blocked for resolution
    /// @dev Maps gameId to a boolean indicating if the game is blocked
    mapping(bytes32 => bool) public gameIdBlockedForResolution;

    /// @notice Mapping to track if a game has been unblocked by an admin
    /// @dev Maps gameId to a boolean indicating if the game was unblocked by an admin
    mapping(bytes32 => bool) public gameIdUnblockedByAdmin;

    /* ========== CONSTRUCTOR ========== */

    /// @notice Initializes the contract with the owner, SportsAMMV2Data, and manager addresses
    /// @param _owner The address of the contract owner
    /// @param _sportsAMMV2Data The address of the SportsAMMV2Data contract
    /// @param _manager The address of the manager contract
    function initialize(address _owner, address _sportsAMMV2Data, address _manager) external initializer {
        setOwner(_owner);
        initNonReentrant();
        sportsAMMData = ISportsAMMV2Data(_sportsAMMV2Data);
        manager = ISportsAMMV2Manager(_manager);
    }

    /// @notice Retrieves the blocked and unblocked status for a list of game IDs
    /// @param gameIds An array of game IDs to check
    /// @return blockedGames An array of booleans indicating if each game is blocked
    /// @return unblockedByAdmin An array of booleans indicating if each game is unblocked by admin
    function getGamesBlockedForResolution(
        bytes32[] memory gameIds
    ) external view returns (bool[] memory blockedGames, bool[] memory unblockedByAdmin) {
        blockedGames = new bool[](gameIds.length);
        unblockedByAdmin = new bool[](gameIds.length);
        for (uint i = 0; i < gameIds.length; i++) {
            blockedGames[i] = gameIdBlockedForResolution[gameIds[i]];
            unblockedByAdmin[i] = gameIdUnblockedByAdmin[gameIds[i]];
        }
    }

    /// @notice Blocks a list of games for resolution
    /// @param _gameIds An array of game IDs to block
    /// @param _reason The reason for blocking the games
    function blockGames(bytes32[] memory _gameIds, string memory _reason) external onlyWhitelistedForBlock(msg.sender) {
        _blockGames(_gameIds, true);
        emit GamesBlockedForResolution(_gameIds, _reason);
    }

    /// @notice Unblocks a list of games for resolution
    /// @param _gameIds An array of game IDs to unblock
    function unblockGames(bytes32[] memory _gameIds) external onlyWhitelistedForUnblock(msg.sender) {
        _blockGames(_gameIds, false);
        emit GamesUnblockedForResolution(_gameIds);
    }

    /// @notice Internal function to block or unblock games
    /// @param _gameIds An array of game IDs to block or unblock
    /// @param _blockGame A boolean indicating whether to block (true) or unblock (false) the games
    function _blockGames(bytes32[] memory _gameIds, bool _blockGame) internal {
        for (uint i = 0; i < _gameIds.length; i++) {
            if (!_blockGame && gameIdBlockedForResolution[_gameIds[i]]) {
                gameIdUnblockedByAdmin[_gameIds[i]] = true;
            } else if (_blockGame && gameIdUnblockedByAdmin[_gameIds[i]]) {
                gameIdUnblockedByAdmin[_gameIds[i]] = false;
            }
            gameIdBlockedForResolution[_gameIds[i]] = _blockGame;
        }
    }

    /// @notice Sets the Sports AMM Manager contract address
    /// @param _manager The address of Sports AMM Manager contract
    function setManager(address _manager) external onlyOwner {
        require(_manager != address(0), "Invalid address");
        manager = ISportsAMMV2Manager(_manager);
        emit SetManager(_manager);
    }

    /// @notice Sets the Sports AMM Data contract address
    /// @param _sportsAMMData The address of Sports AMM Data contract
    function setSportsAMMData(address _sportsAMMData) external onlyOwner {
        require(_sportsAMMData != address(0), "Invalid address");
        sportsAMMData = ISportsAMMV2Data(_sportsAMMData);
        emit SetSportsAMMData(_sportsAMMData);
    }

    /* ========== MODIFIERS ========== */
    /// @notice Modifier to ensure only whitelisted addresses can unblock games
    /// @param sender The address attempting to unblock games
    modifier onlyWhitelistedForUnblock(address sender) {
        require(
            sender == owner || manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING),
            "Invalid sender"
        );
        _;
    }

    /// @notice Modifier to ensure only whitelisted addresses can block games
    /// @param sender The address attempting to block games
    modifier onlyWhitelistedForBlock(address sender) {
        require(
            sender == owner ||
                manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.TICKET_PAUSER) ||
                manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING),
            "Invalid sender"
        );
        _;
    }

    /* ========== EVENTS ========== */
    /// @notice Emitted when the Sports AMM Data contract address is set
    event SetSportsAMMData(address sportsAMMData);
    /// @notice Emitted when the Sports AMM Manager contract address is set
    event SetManager(address manager);
    /// @notice Emitted when games are blocked for resolution
    event GamesBlockedForResolution(bytes32[] gameIds, string reason);
    /// @notice Emitted when games are unblocked for resolution
    event GamesUnblockedForResolution(bytes32[] gameIds);
}
