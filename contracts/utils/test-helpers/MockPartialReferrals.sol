// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test helper: returns a non-zero referrer from `referrals()` but reverts on
/// `getReferrerFee()`. Used to verify the casino's try/catch hardening covers the second
/// referrals call in addition to the first
contract MockPartialReferrals {
    error AlwaysReverts();

    address public constant FAKE_REFERRER = 0x000000000000000000000000000000000000bEEF;

    function referrals(address) external pure returns (address) {
        return FAKE_REFERRER;
    }

    function getReferrerFee(address) external pure returns (uint256) {
        revert AlwaysReverts();
    }

    function setReferrer(address, address) external pure {}
}
