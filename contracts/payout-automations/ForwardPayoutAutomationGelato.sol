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

import {TransferHelper} from "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IWETH9} from "../dependencies/uniswap-v3/IWETH9.sol";

contract ForwardPayoutAutomationGelato is AutomateTaskCreator, ForwardPayoutAutomation {
  using SafeERC20 for IERC20Metadata;

  uint256 private constant WAD = 1e18;

  // TODO: Will all be in a single parameters struct, should fit neatly in a single slot. Should all be settable.
  uint256 private constant priceTolerance = 2e16; // 2%
  ISwapRouter private constant swapRouter = ISwapRouter(0xE592427A0AEce92De3Edee1F18E0157C05861564);
  address private constant WMATIC = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
  uint24 private constant feeTier = 500; // 0.05%

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

  function _handlePayout(
    address riskModule,
    address receiver,
    uint256 amount
  ) internal override {
    (uint256 fee, address feeToken) = _getFeeDetails();

    uint256 wadToCurrencyFactor = (10**(18 - _policyPool.currency().decimals()));
    uint256 ethPrice = IPriceRiskModule(riskModule).oracle().getCurrentPrice();
    uint256 feeInUSDC = (fee * ethPrice) / (WAD * wadToCurrencyFactor);
    feeInUSDC = (feeInUSDC * (WAD + priceTolerance)) / WAD;

    require(
      feeInUSDC < amount,
      "ForwardPayoutAutomationGelato: the payout is not enough to cover the tx fees"
    );
    require(
      feeInUSDC < _policyPool.currency().balanceOf(address(this)),
      "ForwardPayoutAutomationGelato: not enough balance to pay the fee"
    );

    _policyPool.currency().safeApprove(address(swapRouter), type(uint256).max);

    ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
      tokenIn: address(_policyPool.currency()),
      tokenOut: WMATIC,
      fee: feeTier,
      recipient: address(this),
      deadline: block.timestamp,
      amountOut: fee,
      amountInMaximum: feeInUSDC,
      sqrtPriceLimitX96: 0 // TODO: Calculate price limit
    });

    // TODO: empty reverts from SwapRouter or WMATIC withdrawal will not revert the tx. Fix the PolicyPool contract!
    uint256 actualFeeInUSDC = swapRouter.exactOutputSingle(params);

    // Convert the WMATIC to MATIC for fee payment
    IWETH9(WMATIC).withdraw(fee);
    _transfer(fee, feeToken);

    // Send the rest to the owner
    super._handlePayout(riskModule, receiver, amount - actualFeeInUSDC);
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

  // Need to receive gas tokens when unwrapping. TODO: add amount validation to ensure no tokens are ever kept in this contract?
  receive() external payable {}
}
