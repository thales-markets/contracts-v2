// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// internal
import "../utils/libraries/AddressSetLib.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";

contract SportsAMMV2Manager is Initializable, ProxyOwned, ProxyPausable {
    using AddressSetLib for AddressSetLib.AddressSet;

    uint private constant COLLATERAL_DEFAULT_DECIMALS = 18;

    address public sportsAMM;

    mapping(address => mapping(ISportsAMMV2Manager.Role => bool)) public whitelistedAddresses;

    // stores active tickets
    AddressSetLib.AddressSet internal knownTickets;

    // stores active tickets per user
    mapping(address => AddressSetLib.AddressSet) internal activeTicketsPerUser;

    // stores resolved tickets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedTicketsPerUser;

    // stores tickets per game
    mapping(bytes32 => AddressSetLib.AddressSet) internal ticketsPerGame;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner) external initializer {
        setOwner(_owner);
    }

    /* ========== EXTERNAL FUNCTIONS ========== */

    function saveTicketData(
        ISportsAMMV2.TradeData[] memory _tradeData,
        address ticket,
        address user
    ) external onlySportAMMV2 {
        knownTickets.add(ticket);
        activeTicketsPerUser[user].add(ticket);

        for (uint i = 0; i < _tradeData.length; i++) {
            ticketsPerGame[_tradeData[i].gameId].add(ticket);
        }
    }

    function resolveTicketData(address _ticket, address _ticketOwner) external onlySportAMMV2 {
        knownTickets.remove(_ticket);
        activeTicketsPerUser[_ticketOwner].remove(_ticket);

        resolvedTicketsPerUser[_ticketOwner].add(_ticket);
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    function onlyKnownTickets(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    /// @notice is provided ticket active
    /// @param _ticket ticket address
    /// @return isActiveTicket true/false
    function isActiveTicket(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    /// @notice gets batch of active tickets
    /// @param _index start index
    /// @param _pageSize batch size
    /// @return activeTickets
    function getActiveTickets(uint _index, uint _pageSize) external view returns (address[] memory) {
        return knownTickets.getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets
    /// @return numOfActiveTickets
    function numOfActiveTickets() external view returns (uint) {
        return knownTickets.elements.length;
    }

    /// @notice gets batch of active tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active tickets for
    /// @return activeTickets
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return activeTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets per user
    /// @param _user to get number of active tickets for
    /// @return numOfActiveTickets
    function numOfActiveTicketsPerUser(address _user) external view returns (uint) {
        return activeTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of resolved tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved tickets for
    /// @return resolvedTickets
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return resolvedTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of resolved tickets per user
    /// @param _user to get number of resolved tickets for
    /// @return numOfResolvedTickets
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint) {
        return resolvedTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of tickets per game
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _gameId to get tickets for
    /// @return resolvedTickets
    function getTicketsPerGame(uint _index, uint _pageSize, bytes32 _gameId) external view returns (address[] memory) {
        return ticketsPerGame[_gameId].getPage(_index, _pageSize);
    }

    /// @notice gets number of tickets per game
    /// @param _gameId to get number of tickets for
    /// @return numOfTickets
    function numOfTicketsPerGame(bytes32 _gameId) external view returns (uint) {
        return ticketsPerGame[_gameId].elements.length;
    }

    /// @notice checks if address is whitelisted
    /// @param _address address to be checked
    /// @return bool
    function isWhitelistedAddress(address _address, ISportsAMMV2Manager.Role _role) external view returns (bool) {
        return whitelistedAddresses[_address][_role];
    }

    /// @notice transforms collateral if needed - divide by 12 decimals (18 -> 6)
    /// @param value value to be transformed
    /// @param collateral collateral address
    /// @return uint transformed value
    function transformCollateral(uint value, address collateral) external view returns (uint) {
        uint collateralDecimals = ISportsAMMV2Manager(collateral).decimals();
        uint collateralTransformMultiplier = COLLATERAL_DEFAULT_DECIMALS - collateralDecimals;
        return value / (10 ** collateralTransformMultiplier);
    }

    /// @notice reverse collateral if needed - multiple by 12 decimals (6 -> 18)
    /// @param value value to be reversed
    /// @param collateral collateral address
    /// @return uint revered value
    function reverseTransformCollateral(uint value, address collateral) external view returns (uint) {
        uint collateralDecimals = ISportsAMMV2Manager(collateral).decimals();
        uint collateralTransformMultiplier = COLLATERAL_DEFAULT_DECIMALS - collateralDecimals;
        return value * (10 ** collateralTransformMultiplier);
    }

    /* ========== SETTERS ========== */

    /// @notice enables whitelist addresses of given array
    /// @param _whitelistedAddresses array of whitelisted addresses
    /// @param _role adding or removing from whitelist (true: add, false: remove)
    /// @param _flag adding or removing from whitelist (true: add, false: remove)
    function setWhitelistedAddresses(
        address[] calldata _whitelistedAddresses,
        ISportsAMMV2Manager.Role _role,
        bool _flag
    ) external onlyOwner {
        require(_whitelistedAddresses.length > 0, "Whitelisted addresses cannot be empty");
        for (uint256 index = 0; index < _whitelistedAddresses.length; index++) {
            if (whitelistedAddresses[_whitelistedAddresses[index]][_role] != _flag) {
                whitelistedAddresses[_whitelistedAddresses[index]][_role] = _flag;
                emit AddedIntoWhitelist(_whitelistedAddresses[index], _role, _flag);
            }
        }
    }

    function setSportsAMM(address _sportsAMM) external onlyOwner {
        sportsAMM = _sportsAMM;
        emit SportAMMChanged(address(_sportsAMM));
    }

    /* ========== MODIFIERS ========== */

    modifier onlySportAMMV2() {
        require(msg.sender == sportsAMM, "Invalid sportsAMM");
        _;
    }
    /* ========== EVENTS ========== */

    event SportAMMChanged(address sportsAMM);
    event AddedIntoWhitelist(address whitelistedAddresses, ISportsAMMV2Manager.Role role, bool flag);
}
