// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IProxyBetting.sol";

interface IFreeBetsHolder is IProxyBetting {
    function ticketToUser(address _createdTicket) external view returns (address);

    function confirmLiveTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount, address _collateral) external;
    function confirmSGPTrade(bytes32 requestId, address _createdTicket, uint _buyInAmount, address _collateral) external;

    function balancePerUserAndCollateral(address user, address collateral) external view returns (uint);
    function freeBetExpiration(address user, address collateral) external view returns (uint);
    function freeBetExpirationUpgrade() external view returns (uint);
    function freeBetExpirationPeriod() external view returns (uint);
    function confirmSpeedOrChainedSpeedMarketTrade(
        bytes32 _requestId,
        address _speedMarketAddress,
        address _collateral,
        uint _buyinAmount,
        bool _isChained
    ) external;

    function confirmSpeedMarketResolved(
        address _resolvedTicket,
        uint _exercized,
        uint _buyInAmount,
        address _collateral,
        bool isChained
    ) external;

    /// @notice Called by whitelisted casino contracts to consume a user's free bet.
    /// @dev Validates balance, expiry, and caller whitelist. Transfers tokens to caller.
    function useFreeBet(address user, address collateral, uint amount) external;

    /// @notice Called by whitelisted casino contracts after a free-bet bet is resolved or cancelled.
    /// @dev Caller must have already transferred `exercized` of `collateral` to this contract.
    /// On a win (exercized > stake) the stake is forwarded to the owner and the profit to the user.
    /// On a push or cancel (0 < exercized <= stake) the user's free-bet balance is credited.
    function confirmCasinoBetResolved(address user, address collateral, uint exercized, uint stake) external;
}
