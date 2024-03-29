// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SwapLibrary} from "@ensuro/swaplibrary/contracts/SwapLibrary.sol";
import {PayoutAutomationBaseGelato} from "./PayoutAutomationBaseGelato.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IWETH9} from "../dependencies/uniswap-v3/IWETH9.sol";
import {IPool} from "../dependencies/aave-v3/IPool.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {DataTypes} from "../dependencies/aave-v3/DataTypes.sol";

contract AAVERepayPayoutAutomation is PayoutAutomationBaseGelato {
  using SwapLibrary for SwapLibrary.SwapConfig;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPool internal immutable _aave;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(
    IPolicyPool policyPool_,
    address automate_,
    IWETH9 weth_,
    IPool aave_
  ) PayoutAutomationBaseGelato(policyPool_, automate_, weth_) {
    require(address(aave_) != address(0), "AAVERepayPayoutAutomation: you must specify AAVE's Pool address");
    _aave = aave_;
    require(
      aave_.getReserveData(address(policyPool_.currency())).variableDebtTokenAddress != address(0),
      "AAVERepayPayoutAutomation: the protocol currency isn't supported in AAVE"
    );
  }

  function initialize(
    string memory name_,
    string memory symbol_,
    address admin,
    IPriceOracle oracle_,
    SwapLibrary.SwapConfig calldata swapConfig_
  ) public virtual initializer {
    __PayoutAutomationBaseGelato_init(name_, symbol_, admin, oracle_, swapConfig_);
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
      _aave.supply(asset, amount, receiver, 0);
    }
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
