// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {PayoutStrategyBase} from "./PayoutStrategyBase.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";

contract ForwardPayoutStrategy is PayoutStrategyBase {
  using SafeERC20 for IERC20Metadata;

   /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_
  ) PayoutStrategyBase(policyPool_)
  {}

  function _handlePayout(address receiver, uint256 amount) internal override {
    _policyPool.currency().safeTransfer(receiver, amount);
  }
}
