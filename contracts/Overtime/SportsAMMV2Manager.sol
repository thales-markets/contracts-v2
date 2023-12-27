// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// internal
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";

contract SportsAMMV2Manager is Initializable, ProxyOwned, ProxyPausable {
    mapping(address => bool) public whitelistedAddresses;

    bool public needsTransformingCollateral;

    /* ========== CONSTRUCTOR ========== */

    function initialize(address _owner, bool _needsTransformingCollateral) external initializer {
        setOwner(_owner);
        needsTransformingCollateral = _needsTransformingCollateral;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice checks if address is whitelisted
    /// @param _address address to be checked
    /// @return bool
    function isWhitelistedAddress(address _address) external view returns (bool) {
        return whitelistedAddresses[_address];
    }

    /// @notice transforms collateral if needed - divide by 12 decimals (18 -> 6)
    /// @param value value to be transformed
    /// @return uint transformed value
    function transformCollateral(uint value) external view returns (uint) {
        return needsTransformingCollateral ? value / 1e12 : value;
    }

    /// @notice reverse collateral if needed - multiple by 12 decimals (6 -> 18)
    /// @param value value to be reversed
    /// @return uint revered value
    function reverseTransformCollateral(uint value) external view returns (uint) {
        return needsTransformingCollateral ? value * 1e12 : value;
    }

    /* ========== SETTERS ========== */

    /// @notice enables whitelist addresses of given array
    /// @param _whitelistedAddresses array of whitelisted addresses
    /// @param _flag adding or removing from whitelist (true: add, false: remove)
    function setWhitelistedAddresses(address[] calldata _whitelistedAddresses, bool _flag) external onlyOwner {
        require(_whitelistedAddresses.length > 0, "Whitelisted addresses cannot be empty");
        for (uint256 index = 0; index < _whitelistedAddresses.length; index++) {
            if (whitelistedAddresses[_whitelistedAddresses[index]] != _flag) {
                whitelistedAddresses[_whitelistedAddresses[index]] = _flag;
                emit AddedIntoWhitelist(_whitelistedAddresses[index], _flag);
            }
        }
    }

    /// @notice sets needsTransformingCollateral value
    /// @param _needsTransformingCollateral boolean value to be set
    function setNeedsTransformingCollateral(bool _needsTransformingCollateral) external onlyOwner {
        if (needsTransformingCollateral != _needsTransformingCollateral) {
            needsTransformingCollateral = _needsTransformingCollateral;
            emit NeedsTransformingCollateralUpdated(_needsTransformingCollateral);
        }
    }

    /* ========== EVENTS ========== */

    event AddedIntoWhitelist(address whitelistedAddresses, bool flag);
    event NeedsTransformingCollateralUpdated(bool needsTransformingCollateral);
}
