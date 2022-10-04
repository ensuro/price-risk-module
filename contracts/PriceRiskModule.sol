// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "@ensuro/core/contracts/interfaces/IPremiumsAccount.sol";
import {RiskModule} from "@ensuro/core/contracts/RiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {IPriceRiskModule} from "./interfaces/IPriceRiskModule.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/**
 * @title PriceRiskModule
 * @dev Risk Module that triggers the payout if the price of an asset is lower or higher than trigger price
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PriceRiskModule is RiskModule, IPriceRiskModule {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;

  uint8 internal constant ORACLE_DECIMALS = 18; // TODO: is this always the case?

  bytes32 public constant CUSTOMER_ROLE = keccak256("CUSTOMER_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");

  uint8 public constant PRICE_SLOTS = 30;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _asset;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata internal immutable _referenceCurrency;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  uint256 internal immutable _slotSize;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPriceOracle internal immutable _oracle;

  struct PolicyData {
    Policy.PolicyData ensuroPolicy;
    uint256 triggerPrice;
    bool lower; // If true -> triggers if the price is lower, If false -> triggers if the price is higher
  }

  mapping(uint256 => PolicyData) internal _policies;

  // Duration (in hours) of the protection * (1 if lower else -1) => cummulative density function
  //   [0] = prob of ([0, infinite%)
  //   [1] = prob of ([1, infinite%)
  //   ...
  //   [PRICE_SLOTS - 1] = prob of ([PRICE_SLOTS - 1, -infinite%)
  mapping(int40 => uint256[PRICE_SLOTS]) internal _cdf;

  uint96 internal _internalId;

  event NewPricePolicy(
    address indexed customer,
    uint256 policyId,
    uint256 triggerPrice,
    bool lower
  );

  /**
   * @dev Constructs the LiquidationProtectionRiskModule
   * @param policyPool_ The policyPool
   * @param asset_ Address of the asset which price want to protect
   * @param referenceCurrency_ Address of the comparison asset (price will be price(asset)/price(currency))
   * @param slotSize_ Size of each percentage slot in the pdf function (in wad)
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    IERC20Metadata asset_,
    IERC20Metadata referenceCurrency_,
    IPriceOracle oracle_,
    uint256 slotSize_
  ) RiskModule(policyPool_, premiumsAccount_) {
    _asset = asset_;
    _referenceCurrency = referenceCurrency_;
    _slotSize = slotSize_;
    _oracle = oracle_;
  }

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param collRatio_ Collateralization ratio to compute solvency requirement as % of payout (in wad)
   * @param ensuroPpFee_ % of pure premium that will go for Ensuro treasury (in wad)
   * @param srRoc_ return on capital paid to Senior LPs (annualized percentage - in wad)
   * @param maxPayoutPerPolicy_ Maximum payout per policy (in wad)
   * @param exposureLimit_ Max exposure (sum of payouts) to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  function initialize(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) public initializer {
    __RiskModule_init(
      name_,
      collRatio_,
      ensuroPpFee_,
      srRoc_,
      maxPayoutPerPolicy_,
      exposureLimit_,
      wallet_
    );
    _internalId = 1;
  }

  function _convert(
    IERC20Metadata assetFrom,
    IERC20Metadata assetTo,
    uint256 amount
  ) internal view returns (uint256) {
    return amount.wadMul(_getExchangeRate(assetFrom, assetTo));
  }

  function _getExchangeRate(IERC20Metadata assetFrom, IERC20Metadata assetTo)
    public
    view
    returns (uint256)
  {
    uint256 priceFrom = _oracle.getAssetPrice(address(assetFrom));
    require(priceFrom != 0, "Price from not available");

    uint256 priceTo = _oracle.getAssetPrice(address(assetTo));
    require(priceTo != 0, "Price to not available");

    uint8 decTo = assetTo.decimals();

    uint256 exchangeRate = priceFrom.wadDiv(priceTo);

    if (ORACLE_DECIMALS >= decTo) exchangeRate /= 10**(ORACLE_DECIMALS - decTo);
    else exchangeRate *= 10**(decTo - ORACLE_DECIMALS);

    return exchangeRate;
  }

  function _getCurrentPrice() internal view returns (uint256) {
    return _convert(_asset, _referenceCurrency, 10**_asset.decimals());
  }

  /**
   * @dev Returns the premium and lossProb of the policy
   * @param triggerPrice Price of the asset_ that will trigger the policy (expressed in _referenceCurrency)
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
  ) public view override returns (uint256 premium, uint256 lossProb) {
    uint256 currentPrice = _getCurrentPrice();
    require(
      (lower && currentPrice > triggerPrice) || (!lower && currentPrice < triggerPrice),
      "Price already at trigger value"
    );
    lossProb = _computeLossProb(currentPrice, triggerPrice, expiration - uint40(block.timestamp));
    if (lossProb == 0) return (0, 0);
    premium = getMinimumPremium(payout, lossProb, expiration); // TODO: extra fee for RiskModule?
    return (premium, lossProb);
  }

  function _computeLossProb(
    uint256 currentPrice,
    uint256 triggerPrice,
    uint40 duration
  ) internal view returns (uint256) {
    bool lower = currentPrice > triggerPrice;
    uint256[PRICE_SLOTS] storage pdf = _cdf[
      int40((duration + 1800) / 3600) * (lower ? int40(1) : int40(-1))
    ];

    uint256 decimalConv = 10**(ORACLE_DECIMALS - _referenceCurrency.decimals());

    // Calculate the jump percentage as integer with symmetric rounding
    uint256 priceJump;
    if (lower) {
      priceJump = WadRayMath.WAD - (triggerPrice * decimalConv).wadDiv(currentPrice * decimalConv);
    } else {
      priceJump = (triggerPrice * decimalConv).wadDiv(currentPrice * decimalConv) - WadRayMath.WAD;
    }

    uint8 slot = uint8((priceJump + _slotSize / 2) / _slotSize);

    if (slot >= PRICE_SLOTS) {
      return pdf[PRICE_SLOTS - 1];
    } else {
      return pdf[slot];
    }
  }

  function newPolicy(
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration
  ) external override returns (uint256) {
    (uint256 premium, uint256 lossProb) = pricePolicy(triggerPrice, lower, payout, expiration);
    require(premium > 0, "Either duration or percentage jump not supported");

    uint256 policyId = (uint256(uint160(address(this))) << 96) + _internalId;
    PolicyData storage priceRiskPolicy = _policies[policyId];
    address onBehalfOf = _msgSender();
    priceRiskPolicy.ensuroPolicy = _newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      onBehalfOf,
      onBehalfOf,
      _internalId
    );
    _internalId += 1;
    priceRiskPolicy.triggerPrice = triggerPrice;
    priceRiskPolicy.lower = lower;
    emit NewPricePolicy(onBehalfOf, policyId, triggerPrice, lower);
    return policyId;
  }

  function triggerPolicy(uint256 policyId) external override whenNotPaused {
    PolicyData storage policy = _policies[policyId];
    uint256 currentPrice = _getCurrentPrice();
    require(
      !policy.lower || currentPrice <= policy.triggerPrice,
      "Condition not met CurrentPrice > triggerPrice"
    );
    require(
      policy.lower || currentPrice >= policy.triggerPrice,
      "Condition not met CurrentPrice < triggerPrice"
    );

    _policyPool.resolvePolicy(policy.ensuroPolicy, policy.ensuroPolicy.payout);
  }

  /**
   * @dev Sets the probability distribution for a given duration
   * @param duration Duration of the policy in hours (simetric rounding) positive if probability of lower price
   *                 negative if probability of higher price
   * @param cdf Array where cdf[i] = prob of price lower/higher than i% of current price
   */
  function setCDF(int40 duration, uint256[PRICE_SLOTS] calldata cdf)
    external
    onlyComponentRole(PRICER_ROLE)
    whenNotPaused
  {
    _cdf[duration] = cdf;
  }

  function getCDF(int40 duration) external view returns (uint256[PRICE_SLOTS] memory) {
    return _cdf[duration];
  }

  function referenceCurrency() external view override returns (IERC20Metadata) {
    return _referenceCurrency;
  }

  function asset() external view override returns (IERC20Metadata) {
    return _asset;
  }
}
