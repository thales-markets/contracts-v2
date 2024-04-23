// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// internal
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ITicket.sol";

contract SportsAMMV2Manager is Initializable, ProxyOwned, ProxyPausable {
    uint private constant COLLATERAL_DEFAULT_DECIMALS = 18;

    mapping(address => mapping(ISportsAMMV2Manager.Role => bool)) public whitelistedAddresses;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner) external initializer {
        setOwner(_owner);
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

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

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice pause/unapause provided tickets
    /// @param _tickets array of tickets to be paused/unpaused
    /// @param _paused pause/unpause
    function setPausedTickets(address[] calldata _tickets, bool _paused) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            ITicket(_tickets[i]).setPaused(_paused);
        }
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

    /* ========== EVENTS ========== */

    event AddedIntoWhitelist(address whitelistedAddresses, ISportsAMMV2Manager.Role role, bool flag);
}
