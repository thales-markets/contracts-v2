// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/libraries/AddressSetLib.sol";

import "../../interfaces/ISportsAMMV2Data.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "./../AMM/Ticket.sol";

contract ResolveBlocker is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

    ISportsAMMV2Data public sportsAMMData;
    ISportsAMMV2Manager public manager;

    mapping(bytes32 => bool) public gameIdBlockedForResolution;
    mapping(bytes32 => bool) public gameIdUnblockedByAdmin;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner, address _sportsAMMV2Data, address _manager) external initializer {
        setOwner(_owner);
        initNonReentrant();
        sportsAMMData = ISportsAMMV2Data(_sportsAMMV2Data);
        manager = ISportsAMMV2Manager(_manager);
    }

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

    function blockGames(bytes32[] memory _gameIds) external onlyWhitelistedAddresses(msg.sender) {
        _blockGames(_gameIds, true);
    }

    function unblockGames(bytes32[] memory _gameIds) external onlyWhitelistedAddresses(msg.sender) {
        _blockGames(_gameIds, false);
    }

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

    /// @notice sets the Sports AMM Manager contract address
    /// @param _manager the address of Sports AMM Manager contract
    function setManager(address _manager) external onlyOwner {
        require(_manager != address(0), "Invalid address");
        manager = ISportsAMMV2Manager(_manager);
        emit SetManager(_manager);
    }

    /// @notice sets the Sports AMM Data contract address
    /// @param _sportsAMMData the address of Sports AMM Data contract
    function setSportsAMMData(address _sportsAMMData) external onlyOwner {
        require(_sportsAMMData != address(0), "Invalid address");
        sportsAMMData = ISportsAMMV2Data(_sportsAMMData);
        emit SetSportsAMMData(_sportsAMMData);
    }

    /* ========== MODIFIERS ========== */
    modifier onlyWhitelistedAddresses(address sender) {
        require(
            sender == owner || manager.isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING),
            "Invalid sender"
        );
        _;
    }

    /* ========== EVENTS ========== */
    event SetSportsAMMData(address sportsAMMData);
    event SetManager(address manager);
}
