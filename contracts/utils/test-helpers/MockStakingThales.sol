// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2Manager.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";



contract MockStakingThales {
    using SafeERC20 for IERC20;

    mapping(address => uint) public volume;
    mapping(address => uint) public _stakedBalances;
    uint public _totalStakedAmount;

    address public stakingToken;
    address public feeToken;
    address public stakingThalesBettingProxy;

    function stake(uint amount) external {
        _stakedBalances[msg.sender] += amount;
        _totalStakedAmount += amount;
        IERC20(stakingToken).safeTransferFrom(msg.sender, address(this), amount);
    }

    function stakedBalanceOf(address account) external view returns (uint) {
        return _stakedBalances[account];
    }

    function decreaseStakingBalanceFor(address account, uint amount) external onlyStakingProxy {
        _modifyStakingBalance(account, amount, true, stakingThalesBettingProxy);
    }

    function increaseStakingBalanceFor(address account, uint amount) external onlyStakingProxy {
        _modifyStakingBalance(account, amount, false, stakingThalesBettingProxy);
    }

    function _modifyStakingBalance(address _account, uint _amount, bool isDecreasing, address _proxyAccount) internal {
        if (isDecreasing) {
            require(_stakedBalances[_account] >= _amount, "Insufficient staked amount");
            _totalStakedAmount -= _amount;
            _stakedBalances[_account] -= _amount;
            IERC20(stakingToken).safeTransfer(_proxyAccount, _amount);
        } else {

            _totalStakedAmount += _amount;
            _stakedBalances[_account] += _amount;
            IERC20(stakingToken).safeTransferFrom(_proxyAccount, address(this), _amount);
        }
    }

    modifier onlyStakingProxy() {
        require(msg.sender == stakingThalesBettingProxy, "Unsupported staking proxy");
        _;
    }

    function setStakingToken(address _stakingToken) external {
        stakingToken = _stakingToken;
    }

    function setStakingThalesBettingProxy(address _stakingThalesBettingProxy) external {
        stakingThalesBettingProxy = _stakingThalesBettingProxy;
    }

    function updateVolume(address account, uint amount) public {
        uint decimals = ISportsAMMV2Manager(feeToken).decimals();
        if (amount == 0) {
            require(amount > 0, "zero amount received");
        } else if (decimals == 6) {
            require(amount / 1e6 > 0, "Did not receive 6 decimals update volume");
        } else if (decimals == 18) {
            require(amount / 1e18 > 0, "Did not receive 18 decimals update volume");
        } else {
            require(amount > 0, "zero amount received");
        }
        volume[account] = amount;
    }

    function updateVolumeAtAmountDecimals(address account, uint amount, uint decimals) external {
        uint actualAmount = amount;
        uint stakingCollateralDecimals = getFeeTokenDecimals();
        if (decimals < stakingCollateralDecimals) {
            actualAmount = amount * 10 ** (18 - decimals);
        } else if (decimals > stakingCollateralDecimals) {
            actualAmount = amount / 10 ** (18 - stakingCollateralDecimals);
        }
        updateVolume(account, actualAmount);
    }

    function getFeeTokenDecimals() public view returns (uint feeTokenDecimals) {
        feeTokenDecimals = ISportsAMMV2Manager(feeToken).decimals();
    }

    function setFeeToken(address _feeToken) external {
        feeToken = _feeToken;
    }
}
