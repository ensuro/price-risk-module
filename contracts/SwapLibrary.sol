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

  uint256 internal constant WAD = 1e18;

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

  function validate(SwapConfig calldata swapConfig) external pure {
    require(swapConfig.maxSlippage > 0, "SwapLibrary: maxSlippage cannot be zero");
    if (swapConfig.protocol == SwapProtocol.uniswap) {
      (uint24 feeTier_, ISwapRouter router_) = abi.decode(
        swapConfig.customParams,
        (uint24, ISwapRouter)
      );
      require(address(router_) != address(0), "SwapLibrary: SwapRouter address cannot be zero");
      require(feeTier_ > 0, "SwapLibrary: feeTier cannot be zero");
    } else require(swapConfig.protocol != SwapProtocol.undefined, "SwapLibrary: Invalid Protocol");
  }

  function exactInput(
    SwapConfig storage swapConfig,
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
    SwapConfig storage swapConfig,
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
    SwapConfig storage swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) internal returns (uint256) {
    (uint24 feeTier_, ISwapRouter router_) = abi.decode(
      swapConfig.customParams,
      (uint24, ISwapRouter)
    );

    uint256 _wadToCurrencyFactor = (10 ** (18 - IERC20Metadata(tokenIn).decimals()));
    uint256 currencyMin = (amount * _wadToCurrencyFactor).wadDiv(price).wadMul(
      WAD - swapConfig.maxSlippage
    );
    IERC20Metadata(tokenIn).approve(address(router_), amount);
    ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      fee: feeTier_,
      recipient: address(this),
      deadline: block.timestamp,
      amountIn: amount,
      amountOutMinimum: currencyMin,
      sqrtPriceLimitX96: 0 // Since we're limiting the transfer amount, we don't need to worry about the price impact of the transaction
    });

    uint256 received = router_.exactInputSingle(params);

    // Sanity check
    require(received >= currencyMin, "SwapLibrary: the payout is not enough to cover the tx fees");
    return received;
  }

  function _exactOutputUniswap(
    SwapConfig storage swapConfig,
    address tokenIn,
    address tokenOut,
    uint256 amount,
    uint256 price
  ) internal returns (uint256) {
    (uint24 feeTier_, ISwapRouter router_) = abi.decode(
      swapConfig.customParams,
      (uint24, ISwapRouter)
    );

    uint256 _wadToCurrencyFactor = (10 ** (18 - IERC20Metadata(tokenIn).decimals()));
    uint256 feeInCurrency = (amount.wadMul(price) / _wadToCurrencyFactor).wadMul(
      WAD + swapConfig.maxSlippage
    );
    IERC20Metadata(tokenIn).approve(address(router_), amount);

    ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      fee: feeTier_,
      recipient: address(this),
      deadline: block.timestamp,
      amountOut: amount,
      amountInMaximum: feeInCurrency,
      sqrtPriceLimitX96: 0 // Since we're limiting the transfer amount, we don't need to worry about the price impact of the transaction
    });
    uint256 actualFee = router_.exactOutputSingle(params);

    // Sanity check
    require(actualFee <= feeInCurrency, "SwapLibrary: exchange rate higher than tolerable");
    return actualFee;
  }
}
