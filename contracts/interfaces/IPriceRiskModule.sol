// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {IRiskModule} from "@ensuro/core/contracts/interfaces/IRiskModule.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title IPriceRiskModule interface
 * @dev Interface for price risk module
 * @author Ensuro
 */
interface IPriceRiskModule is IRiskModule {
  /**
   * @dev Returns the premium and lossProb of the policy
   * @param triggerPrice Price of the asset_ that will trigger the policy (expressed in _currency)
   * @param lower If true -> triggers if the price is lower, If false -> triggers if the price is higher
   * @param payout Expressed in policyPool.currency()
   * @param expiration Expiration of the policy
   * @return premium Premium that needs to be paid
   * @return lossProb Probability of paying the maximum payout
   */
  function pricePolicy(
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration
  ) external view returns (uint256 premium, uint256 lossProb);

  function newPolicy(
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration,
    address onBehalfOf
  ) external returns (uint256);

  function triggerPolicy(uint256 policyId) external;

  function referenceOracle() external view returns (AggregatorV3Interface);

  function assetOracle() external view returns (AggregatorV3Interface);

  /**
   * @dev  Max acceptable age for price data.
   *       If the most recent price is older than (now - tolerance) no policies can be created or resolved.
   */
  function oracleTolerance() external view returns (uint40);

  /**
   * @dev In seconds, the minimum time that must elapse before a policy can be triggered, since creation
   */
  function minDuration() external view returns (uint40);
}
