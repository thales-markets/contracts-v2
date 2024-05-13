// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// external
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./library/Path.sol";

contract MockUniswap {
    using SafeERC20 for IERC20;
    using Path for bytes;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another along the specified path
    /// @param params The parameters necessary for the multi-hop swap, encoded as `ExactInputParams` in calldata
    /// @return amountOut The amount of the received token
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        // (address tokenIn, , , , address tokenOut) = abi.decode(params.path, (address, uint24, address, uint24, address));
        (address tokenIn, , ) = params.path.decodeFirstPool();
        bytes memory leftoverPath = params.path.skipToken();
        (, address tokenOut, ) = leftoverPath.decodeFirstPool();
        amountOut = params.amountOutMinimum;
        IERC20(tokenIn).safeTransferFrom(params.recipient, address(this), params.amountIn);
        IERC20(tokenOut).safeTransfer(params.recipient, params.amountOutMinimum);
        emit SwapedTokens(params.recipient, tokenIn, params.amountIn, tokenOut, params.amountOutMinimum);
    }

    event SwapedTokens(
        address indexed recipient,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMinimum
    );

    function withdraw(address _collateral) external {
        uint amount = IERC20(_collateral).balanceOf(address(this));
        IERC20(_collateral).safeTransfer(msg.sender, amount);
    }
}
