// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SwapLibrary} from "./../SwapLibrary.sol";
import {PayoutAutomationBaseGelato} from "./PayoutAutomationBaseGelato.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IWETH9} from "../dependencies/uniswap-v3/IWETH9.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

contract ForwardPayoutAutomation is PayoutAutomationBaseGelato {
  using SafeERC20 for IERC20Metadata;

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(
    IPolicyPool policyPool_,
    address automate_,
    IWETH9 weth_
  ) PayoutAutomationBaseGelato(policyPool_, automate_, weth_) {}

  function initialize(
    string memory name_,
    string memory symbol_,
    address admin,
    IPriceOracle oracle_,
    SwapLibrary.SwapConfig calldata swapConfig_
  ) public initializer {
    __PayoutAutomationBaseGelato_init(name_, symbol_, admin, oracle_, swapConfig_);
  }

  function _handlePayout(address receiver, uint256 amount) internal virtual override {
    _policyPool.currency().safeTransfer(receiver, amount);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
