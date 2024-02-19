// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {WadRayMath} from "@ensuro/core/contracts/dependencies/WadRayMath.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title Swap Library
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library SwapLibrary {
  using WadRayMath for uint256;

  /**
   * @dev Enum with the different protocols
   */
  enum SwapProtocol {
    undefined,
    uniswap
  }

  struct SwapConfig {
    SwapProtocol protocol;
    uint256 maxSlippage;
    bytes customParams;
  }

  struct UniswapCustomParams {
    uint24 feeTier;
    ISwapRouter router;
  }

  function validate(SwapConfig calldata swapConfig) external pure {
    require(swapConfig.maxSlippage > 0, "SwapLibrary: maxSlippage cannot be zero");
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      UniswapCustomParams memory cp = abi.decode(swapConfig.customParams, (UniswapCustomParams));
      require(address(cp.router) != address(0), "SwapLibrary: SwapRouter address cannot be zero");
      require(cp.feeTier > 0, "SwapLibrary: feeTier cannot be zero");
    } else revert("SwapLibrary: invalid protocol");
  }

  function _toWadFactor(address token) internal view returns (uint256) {
    return (10 ** (18 - IERC20Metadata(token).decimals()));
  }

  function exactInput(
    SwapConfig calldata swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) external returns (uint256) {
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      return _exactInputUniswap(swapConfig, tokenIn, tokenOut, amount, price);
    }
    return 0;
  }

  function exactOutput(
    SwapConfig calldata swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) external returns (uint256) {
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      return _exactOutputUniswap(swapConfig, tokenIn, tokenOut, amount, price);
    }
    return 0;
  }

  function _exactInputUniswap(
    SwapConfig calldata swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) internal returns (uint256) {
    UniswapCustomParams memory cp = abi.decode(swapConfig.customParams, (UniswapCustomParams));
    uint256 currencyMin = (amount * _toWadFactor(tokenIn)).wadDiv(price).wadMul(
      WadRayMath.WAD - swapConfig.maxSlippage
    ) / _toWadFactor(tokenOut);

    IERC20Metadata(tokenIn).approve(address(cp.router), amount);
    ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      fee: cp.feeTier,
      recipient: address(this),
      deadline: block.timestamp,
      amountIn: amount,
      amountOutMinimum: currencyMin,
      sqrtPriceLimitX96: 0 // Since we're limiting the transfer amount, we don't need to worry about the price impact of the transaction
    });

    uint256 received = cp.router.exactInputSingle(params);

    require(
      IERC20Metadata(tokenIn).allowance(address(this), address(cp.router)) == 0,
      "SwapLibrary: something wrong, allowance should go back to 0"
    );
    // Sanity check
    require(received >= currencyMin, "SwapLibrary: the payout is not enough to cover the tx fees");
    return received;
  }

  function _exactOutputUniswap(
    SwapConfig calldata swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) internal returns (uint256) {
    UniswapCustomParams memory cp = abi.decode(swapConfig.customParams, (UniswapCustomParams));

    uint256 amountInMax = (amount * _toWadFactor(tokenOut)).wadMul(price).wadMul(
      WadRayMath.WAD + swapConfig.maxSlippage
    ) / _toWadFactor(tokenIn);
    IERC20Metadata(tokenIn).approve(address(cp.router), type(uint256).max);

    ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      fee: cp.feeTier,
      recipient: address(this),
      deadline: block.timestamp,
      amountOut: amount,
      amountInMaximum: amountInMax,
      sqrtPriceLimitX96: 0 // Since we're limiting the transfer amount, we don't need to worry about the price impact of the transaction
    });
    uint256 actualAmount = cp.router.exactOutputSingle(params);

    IERC20Metadata(tokenIn).approve(address(cp.router), 0);

    // Sanity check
    require(actualAmount <= amountInMax, "SwapLibrary: exchange rate higher than tolerable");
    return actualAmount;
  }
}
