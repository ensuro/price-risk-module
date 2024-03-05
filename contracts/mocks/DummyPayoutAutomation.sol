// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {PayoutAutomationBase} from "../payout-automations/PayoutAutomationBase.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";

contract DummyPayoutAutomation is PayoutAutomationBase {
  event Payout(uint256 amount, address receiver);

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PayoutAutomationBase(policyPool_) {}

  function initialize(string memory name_, string memory symbol_, address admin) public virtual initializer {
    __PayoutAutomationBase_init(name_, symbol_, admin);
  }

  function _handlePayout(address receiver, uint256 amount) internal virtual override {
    emit Payout(amount, receiver);
  }
}
