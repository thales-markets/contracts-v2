// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IProxyBetting.sol";

interface IFreeBetsHolder is IProxyBetting {
    function confirmLiveTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount, address _collateral) external;
    function confirmSGPTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount, address _collateral) external;

    function balancePerUserAndCollateral(address user, address collateral) external view returns (uint);
    function freeBetExpiration(address user, address collateral) external view returns (uint);
    function freeBetExpirationUpgrade() external view returns (uint);
    function freeBetExpirationPeriod() external view returns (uint);
}
