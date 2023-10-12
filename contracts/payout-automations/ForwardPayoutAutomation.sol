// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {PayoutAutomationBase} from "./PayoutAutomationBase.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";

contract ForwardPayoutAutomation is PayoutAutomationBase {
  using SafeERC20 for IERC20Metadata;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PayoutAutomationBase(policyPool_) {}

  function initializeAuto(
    string memory name_,
    string memory symbol_,
    address admin
  ) public virtual initializer {
    __PayoutAutomationBase_init(name_, symbol_, admin);
  }

  function _handlePayout(
    address, // riskmodule
    address receiver,
    uint256 amount
  ) internal virtual override {
    _policyPool.currency().safeTransfer(receiver, amount);
  }
}
