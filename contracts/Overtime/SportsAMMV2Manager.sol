// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// internal
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";

contract SportsAMMV2Manager is Initializable, ProxyOwned, ProxyPausable {
    mapping(address => bool) public whitelistedAddresses;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner) external initializer {
        setOwner(_owner);
    }

    /* ========== SETTERS ========== */

    /// @notice setWhitelistedAddresses enables whitelist addresses of given array
    /// @param _whitelistedAddresses array of whitelisted addresses
    /// @param _flag adding or removing from whitelist (true: add, false: remove)
    function setWhitelistedAddresses(address[] calldata _whitelistedAddresses, bool _flag) external onlyOwner {
        require(_whitelistedAddresses.length > 0, "Whitelisted addresses cannot be empty");
        for (uint256 index = 0; index < _whitelistedAddresses.length; index++) {
            // only if current flag is different, if same skip it
            if (whitelistedAddresses[_whitelistedAddresses[index]] != _flag) {
                whitelistedAddresses[_whitelistedAddresses[index]] = _flag;
                emit AddedIntoWhitelist(_whitelistedAddresses[index], _flag);
            }
        }
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    function isWhitelistedAddress(address _address) external view returns (bool) {
        return whitelistedAddresses[_address];
    }

    /* ========== EVENTS ========== */

    event AddedIntoWhitelist(address whitelistedAddresses, bool flag);
}
