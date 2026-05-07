// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test helper: a Referrals-shaped contract whose every method reverts. Used to verify
/// the casino's try/catch hardening — bets must still settle when referrals is broken
contract MockBrokenReferrals {
    error AlwaysReverts();

    function referrals(address) external pure returns (address) {
        revert AlwaysReverts();
    }

    function getReferrerFee(address) external pure returns (uint256) {
        revert AlwaysReverts();
    }

    function setReferrer(address, address) external pure {
        revert AlwaysReverts();
    }
}
