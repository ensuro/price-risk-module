// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {WadRayMath} from "@ensuro/core/contracts/dependencies/WadRayMath.sol";

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {TransferHelper} from "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

import {AutomateTaskCreator} from "../dependencies/gelato-v2/AutomateTaskCreator.sol";
import {Module, ModuleData} from "../dependencies/gelato-v2/Types.sol";
import {IWETH9} from "../dependencies/uniswap-v3/IWETH9.sol";

import {IPriceRiskModule} from "../interfaces/IPriceRiskModule.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

import {ForwardPayoutAutomation} from "./ForwardPayoutAutomation.sol";
import {PayoutAutomationBase} from "./PayoutAutomationBase.sol";

// import "hardhat/console.sol";

contract ForwardPayoutAutomationGelato is AutomateTaskCreator, ForwardPayoutAutomation {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;
  using SafeCast for uint256;

  uint256 private constant WAD = 1e18;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  uint256 private immutable _wadToCurrencyFactor;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IWETH9 private immutable weth;

  struct SwapParams {
    ISwapRouter swapRouter;
    uint24 feeTier;
  }

  SwapParams private swapParams;

  IPriceOracle private oracle;
  uint256 private priceTolerance;

  /**
   * @param policyPool_ Address of the policy pool
   * @param _automate Address of the Gelato's Automate contract
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(
    IPolicyPool policyPool_,
    address _automate,
    IWETH9 weth_
  ) AutomateTaskCreator(_automate, address(this)) ForwardPayoutAutomation(policyPool_) {
    weth = weth_;
    _wadToCurrencyFactor = (10**(18 - _policyPool.currency().decimals()));
  }

  function initialize(
    string memory name_,
    string memory symbol_,
    address admin,
    IPriceOracle oracle_,
    ISwapRouter swapRouter_,
    uint24 feeTier_
  ) public virtual initializer {
    __PayoutAutomationBase_init(name_, symbol_, admin);

    oracle = oracle_;
    swapParams.swapRouter = swapRouter_;
    swapParams.feeTier = feeTier_;
    priceTolerance = 2e16; // 2%
  }

  function _handlePayout(
    address riskModule,
    address receiver,
    uint256 amount
  ) internal override {
    (uint256 fee, address feeToken) = _getFeeDetails();

    uint256 feeInUSDC = (fee.wadMul(oracle.getCurrentPrice()) / _wadToCurrencyFactor).wadMul(
      WAD + priceTolerance
    );

    require(
      feeInUSDC < amount,
      "ForwardPayoutAutomationGelato: the payout is not enough to cover the tx fees"
    );

    _policyPool.currency().safeApprove(address(swapParams.swapRouter), feeInUSDC);

    ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
      tokenIn: address(_policyPool.currency()),
      tokenOut: address(weth),
      fee: swapParams.feeTier,
      recipient: address(this),
      deadline: block.timestamp,
      amountOut: fee,
      amountInMaximum: feeInUSDC,
      sqrtPriceLimitX96: 0 // TODO: Calculate price limit
    });

    // TODO: empty reverts from SwapRouter or WMATIC withdrawal will not revert the tx. Fix the PolicyPool contract!
    uint256 actualFeeInUSDC = swapParams.swapRouter.exactOutputSingle(params);

    if (actualFeeInUSDC < feeInUSDC)
      _policyPool.currency().safeApprove(address(swapParams.swapRouter), 0);

    // Convert the WMATIC to MATIC for fee payment
    weth.withdraw(fee);
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
