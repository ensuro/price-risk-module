// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ForwardPayoutAutomation} from "./ForwardPayoutAutomation.sol";
import {PayoutAutomationBase} from "./PayoutAutomationBase.sol";

import {AutomateTaskCreator} from "../dependencies/gelato-v2/AutomateTaskCreator.sol";
import {Module, ModuleData} from "../dependencies/gelato-v2/Types.sol";

import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPriceRiskModule} from "../interfaces/IPriceRiskModule.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract ForwardPayoutAutomationGelato is AutomateTaskCreator, ForwardPayoutAutomation {
  /**
   * @param policyPool_ Address of the policy pool
   * @param _automate Address of the Gelato's Automate contract
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_, address _automate)
    AutomateTaskCreator(_automate, address(this))
    ForwardPayoutAutomation(policyPool_)
  {}

  function _handlePayout(address receiver, uint256 amount) internal override {
    (uint256 fee, address feeToken) = _getFeeDetails();
    _transfer(fee, feeToken);
    // TODO: Obtain fee calculation, exchange USDC for ETH, pay fee, call super with amount - fee exchanged.
    // Slipage / exchange rate spread? Add tests and validations.

    super._handlePayout(receiver, amount);
  }

  /**
   * @inheritdoc PayoutAutomationBase
   */
  function newPolicy(
    IPriceRiskModule riskModule,
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration,
    address onBehalfOf
  ) public virtual override returns (uint256 policyId) {
    policyId = super.newPolicy(riskModule, triggerPrice, lower, payout, expiration, onBehalfOf);

    ModuleData memory moduleData = ModuleData({modules: new Module[](1), args: new bytes[](1)});
    moduleData.modules[0] = Module.RESOLVER;
    moduleData.args[0] = _resolverModuleArg(
      address(this),
      abi.encodeCall(this.checker, (riskModule, policyId))
    );

    _createTask(
      address(riskModule),
      abi.encode(riskModule.triggerPolicy.selector),
      moduleData,
      ETH
    );
  }

  function checker(IPriceRiskModule riskModule, uint256 policyId)
    external
    view
    returns (bool canExec, bytes memory execPayload)
  {
    canExec = riskModule.policyCanBeTriggered(policyId);
    execPayload = abi.encodeCall(riskModule.triggerPolicy, (policyId));
  }
}
