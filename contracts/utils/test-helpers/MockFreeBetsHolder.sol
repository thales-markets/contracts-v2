// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockFreeBetsHolder
/// @notice Minimal FBH stub for V2 casino tests. Mirrors the real FBH's casino-side surface
/// (`useFreeBet` + `confirmCasinoBetResolved`) without any of the sports/live trading machinery
contract MockFreeBetsHolder {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public balancePerUserAndCollateral;
    address public daoSink; // where stakes go on win (= "owner" in real FBH)

    uint256 public confirmCalls;
    uint256 public lastExercised;
    uint256 public lastStake;

    constructor(address _daoSink) {
        daoSink = _daoSink;
    }

    /// @notice Test-only: top up a user's free-bet balance. The caller must pre-fund this
    /// contract with the corresponding ERC20 amount
    function setBalance(address user, address collateral, uint256 amount) external {
        balancePerUserAndCollateral[user][collateral] = amount;
    }

    /// @notice Mirror of the real FBH. Caller (the casino game's core) gets the tokens
    function useFreeBet(address user, address collateral, uint256 amount) external {
        require(balancePerUserAndCollateral[user][collateral] >= amount, "MockFBH: InsufficientBalance");
        balancePerUserAndCollateral[user][collateral] -= amount;
        IERC20(collateral).safeTransfer(msg.sender, amount);
    }

    /// @notice Test-only forwarder. Some V2 games (e.g. OvertimeUltimateHoldem, VideoPoker)
    /// gate `placeBetWithFreeBet` to be callable ONLY by the FBH address and identify the user
    /// via `tx.origin`. This helper lets a test EOA call through the mock FBH so that
    /// `msg.sender == this` and `tx.origin == EOA` inside the game contract
    function forwardCall(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // bubble the revert reason
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    /// @notice Mirror of the real FBH. Caller has already transferred `exercised` to this
    /// contract before calling. exercised > stake → stake → daoSink, profit → user.
    /// exercised <= stake → credited back to user's free-bet balance
    function confirmCasinoBetResolved(address user, address collateral, uint256 exercised, uint256 stake) external {
        confirmCalls++;
        lastExercised = exercised;
        lastStake = stake;
        if (exercised == 0) return;
        if (exercised > stake) {
            IERC20(collateral).safeTransfer(daoSink, stake);
            uint256 profit = exercised - stake;
            if (profit > 0) {
                IERC20(collateral).safeTransfer(user, profit);
            }
        } else {
            balancePerUserAndCollateral[user][collateral] += exercised;
        }
    }
}
