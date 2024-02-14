// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title Swap Library
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library SwapLibrary {
  /**
   * @dev Enum with the different protocols
   */
  enum SwapProtocol {
    undefined,
    uniswap,
    curve
  }

  struct SwapConfig {
    SwapProtocol protocol;
    uint256 maxSlippage;
    bytes customParams;
  }

  function validate(SwapConfig calldata swapConfig) external pure {
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      require(swapConfig.maxSlippage > 0, "SwapLibrary: maxSlippage cannot be zero");
      (uint24 feeTier_, ISwapRouter router_) = abi.decode(
        swapConfig.customParams,
        (uint24, ISwapRouter)
      );
      require(address(router_) != address(0), "SwapLibrary: SwapRouter address cannot be zero");
      require(feeTier_ > 0, "SwapLibrary: feeTier cannot be zero");
    }
  }

  function exactInput(
    SwapConfig storage swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) external returns (uint256) {
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      (uint24 feeTier_, ISwapRouter router_) = abi.decode(
        swapConfig.customParams,
        (uint24, ISwapRouter)
      );
      IERC20Metadata(tokenIn).approve(address(router_), amount);
      ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        fee: feeTier_,
        recipient: address(this),
        deadline: block.timestamp,
        amountIn: amount,
        amountOutMinimum: price,
        sqrtPriceLimitX96: 0 // Since we're limiting the transfer amount, we don't need to worry about the price impact of the transaction
      });

      return router_.exactInputSingle(params);
    }
    return 0;
  }

  function exactOutput(
    SwapConfig storage swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) external returns (uint256) {
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      (uint24 feeTier_, ISwapRouter router_) = abi.decode(
        swapConfig.customParams,
        (uint24, ISwapRouter)
      );
      ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        fee: feeTier_,
        recipient: address(this),
        deadline: block.timestamp,
        amountOut: amount,
        amountInMaximum: price,
        sqrtPriceLimitX96: 0 // Since we're limiting the transfer amount, we don't need to worry about the price impact of the transaction
      });

      return router_.exactOutputSingle(params);
    }
    return 0;
  }
}
