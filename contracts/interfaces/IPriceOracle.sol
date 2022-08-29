// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IPriceOracle - Interface for external price oracle to get assets' prices
 * @author Ensuro
 */
interface IPriceOracle {
  /**
   * @dev Returns the price of the asset in ETH
   * @param asset Address of a ERC20 asset
   * @return Price of the asset in ETH (Wad)
   */
  function getAssetPrice(address asset) external view returns (uint256);
}
