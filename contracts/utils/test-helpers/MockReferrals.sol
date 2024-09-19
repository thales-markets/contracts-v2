// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

contract MockReferrals {
    mapping(address => address) public sportReferrals;

    uint public referrerFeeDefault;
    uint public referrerFeeSilver;
    uint public referrerFeeGold;

    mapping(address => bool) public silverAddresses;
    mapping(address => bool) public goldAddresses;

    function getReferrerFee(address referrer) external view returns (uint) {
        return
            goldAddresses[referrer] ? referrerFeeGold : (silverAddresses[referrer] ? referrerFeeSilver : referrerFeeDefault);
    }

    function setReferrer(address referrer, address referred) external {
        require(referrer != address(0) && referred != address(0), "Cant refer zero addresses");
        require(referrer != referred, "Cant refer to yourself");
        sportReferrals[referred] = referrer;
    }

    function setReferrerFees(uint _referrerFeeDefault, uint _referrerFeeSilver, uint _referrerFeeGold) external {
        referrerFeeDefault = _referrerFeeDefault;
        referrerFeeSilver = _referrerFeeSilver;
        referrerFeeGold = _referrerFeeGold;
    }
}
