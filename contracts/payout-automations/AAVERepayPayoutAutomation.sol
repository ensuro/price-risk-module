// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {PayoutAutomationBase} from "./PayoutAutomationBase.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPool} from "../dependencies/aave-v3/IPool.sol";
import {DataTypes} from "../dependencies/aave-v3/DataTypes.sol";

contract AAVERepayPayoutAutomation is PayoutAutomationBase {
  using SafeERC20 for IERC20Metadata;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPool internal immutable _aave;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_, IPool aave_) PayoutAutomationBase(policyPool_) {
    require(
      address(aave_) != address(0),
      "AAVERepayPayoutAutomation: you must specify AAVE's Pool address"
    );
    _aave = aave_;
    require(
      aave_.getReserveData(address(policyPool_.currency())).variableDebtTokenAddress != address(0),
      "AAVERepayPayoutAutomation: the protocol currency isn't supported in AAVE"
    );
  }

  function initialize(
    string memory name_,
    string memory symbol_,
    address admin
  ) public virtual initializer {
    __PayoutAutomationBase_init(name_, symbol_, admin);
    // Infinite approval to AAVE to avoid approving every time
    _policyPool.currency().approve(address(_aave), type(uint256).max);
  }

  function _handlePayout(address receiver, uint256 amount) internal override {
    address asset = address(_policyPool.currency());
    DataTypes.ReserveData memory reserveData = _aave.getReserveData(asset);
    uint256 debt = IERC20Metadata(reserveData.variableDebtTokenAddress).balanceOf(receiver);
    if (debt > 0) {
      amount -= _aave.repay(asset, Math.min(debt, amount), 2, receiver);
    }
    if (amount != 0) {
      debt = IERC20Metadata(reserveData.stableDebtTokenAddress).balanceOf(receiver);
      if (debt > 0) {
        amount -= _aave.repay(asset, Math.min(debt, amount), 1, receiver);
      }
    }
    if (amount != 0) {
      _aave.deposit(asset, amount, receiver, 0);
    }
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
