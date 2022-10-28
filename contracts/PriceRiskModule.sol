// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "@ensuro/core/contracts/interfaces/IPremiumsAccount.sol";
import {RiskModule} from "@ensuro/core/contracts/RiskModule.sol";
import {Policy} from "@ensuro/core/contracts/Policy.sol";
import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {IPriceRiskModule} from "./interfaces/IPriceRiskModule.sol";

/**
 * @title PriceRiskModule
 * @dev Risk Module that triggers the payout if the price of an asset is lower or higher than trigger price
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PriceRiskModule is RiskModule, IPriceRiskModule {
  using SafeERC20 for IERC20Metadata;
  using WadRayMath for uint256;

  bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");

  uint8 public constant PRICE_SLOTS = 30;

  uint8 public constant WAD_DECIMALS = 18;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  uint256 internal immutable _slotSize;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  AggregatorV3Interface internal immutable _assetOracle;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  AggregatorV3Interface internal immutable _referenceOracle;

  uint256 internal _oracleTolerance;

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
   * @dev Constructs the PriceRiskModule.
   *      Note that, although it's supported that assetOracle_ and  referenceOracle_ have different number
   *      of decimals, they're assumed to be in the same denomination. For instance, assetOracle_ could be
   *      WMATIC/ETH and referenceOracle_ could be for USDC/ETH.
   *      This cannot be validated by the contract, so be careful when constructing.
   *
   * @param policyPool_ The policyPool
   * @param assetOracle_ Address of the price feed oracle for the asset
   * @param referenceOracle_ Address of the price feed oracle for the reference currency. If it's
   *                         the zero address the asset price will be considered directly.
   * @param slotSize_ Size of each percentage slot in the pdf function (in wad)
   */
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    AggregatorV3Interface assetOracle_,
    AggregatorV3Interface referenceOracle_,
    uint256 slotSize_
  ) RiskModule(policyPool_, premiumsAccount_) {
    require(
      address(assetOracle_) != address(0),
      "PriceRiskModule: assetOracle_ cannot be the zero address"
    );
    _slotSize = slotSize_;
    _assetOracle = assetOracle_;
    _referenceOracle = referenceOracle_;
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
   * @param oracleTolerance_ Max acceptable age of price data, in seconds
   */
  function initialize(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_,
    uint256 oracleTolerance_
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
    _oracleTolerance = oracleTolerance_;
  }

  /**
   * @dev Creates a new policy
   * @param triggerPrice The price at which the policy should trigger, expressed with the same
   *                     decimals as reported by the asset oracle
   * @param lower If true -> triggers if the price is lower, If false -> triggers if the price is higher
   * @param payout Expressed in policyPool.currency()
   * @param expiration The policy expiration timestamp
   * @return policyId
   */
  function newPolicy(
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration
  ) external override whenNotPaused returns (uint256) {
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
   * @dev Calculates the premium and lossProb of a policy
   * @param triggerPrice Price of the asset that will trigger the policy (expressed in the reference currency
   *                     as reported by the oracle, or the asset denomination as reported by the oracle if no
   *                     referenceAsset)
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
    premium = getMinimumPremium(payout, lossProb, expiration);
    return (premium, lossProb);
  }

  function _getCurrentPrice() internal view returns (uint256) {
    if (address(_referenceOracle) == address(0)) return _getLatestPrice(_assetOracle);

    return _convert(_assetOracle, _referenceOracle, 10**_assetOracle.decimals());
  }

  /**
   * @dev Converts between two assets given their price aggregators
   * @param from the aggregator for the origin asset
   * @param to the aggregator for the destination asset
   * @param amount the amount to convert, expressed with the same decimals as the from aggregator
   * @return The converted amount, expressed with the same decimals as the to aggregator
   */
  function _convert(
    AggregatorV3Interface from,
    AggregatorV3Interface to,
    uint256 amount
  ) internal view returns (uint256) {
    require(
      address(from) != address(0) && address(to) != address(0),
      "Both oracles required for conversion"
    );
    uint256 converted = scalePrice(amount, from.decimals(), WAD_DECIMALS).wadMul(
      _getExchangeRate(from, to)
    );
    return scalePrice(converted, WAD_DECIMALS, to.decimals());
  }

  /**
   * @dev Calculates the exchange rate between the prices returned by the two aggregators
   *      Assumes that both aggregators are returning prices using the same quote.
   *      Although it's usual that the aggregators return prices with the same number of
   *      decimals, this is not required. Both prices will be scaled to Wad before calculating the
   *      rate.
   * @param base the aggregator for the base
   * @param quote the aggregator for the quote asset. Can be the zero address, in which case the
   *              base asset price is returned without any calculations performed.
   * @return The exchange rate from/to in Wad
   */
  function _getExchangeRate(AggregatorV3Interface base, AggregatorV3Interface quote)
    public
    view
    returns (uint256)
  {
    require(address(base) != address(0), "Base oracle required");

    uint256 basePrice = scalePrice(_getLatestPrice(base), base.decimals(), WAD_DECIMALS);
    require(basePrice != 0, "Price from not available");

    if (address(quote) == address(0)) return basePrice;

    uint256 quotePrice = scalePrice(_getLatestPrice(quote), quote.decimals(), WAD_DECIMALS);
    require(quotePrice != 0, "Price to not available");

    return basePrice.wadDiv(quotePrice);
  }

  function _getLatestPrice(AggregatorV3Interface oracle) internal view returns (uint256) {
    (, int256 price, , uint256 updatedAt, ) = oracle.latestRoundData();
    require(updatedAt > block.timestamp - _oracleTolerance, "Price is older than tolerable");

    return SafeCast.toUint256(price);
  }

  function scalePrice(
    uint256 price,
    uint8 priceDecimals,
    uint8 decimals
  ) internal pure returns (uint256) {
    if (priceDecimals < decimals) return price * 10**(decimals - priceDecimals);
    else return price / 10**(priceDecimals - decimals);
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

    uint8 priceDecimals = address(_referenceOracle) == address(0)
      ? _assetOracle.decimals()
      : _referenceOracle.decimals();

    // Calculate the jump percentage as integer with symmetric rounding
    uint256 priceJump;
    if (lower) {
      // 1 - trigger/current
      priceJump =
        WadRayMath.WAD -
        scalePrice(triggerPrice, priceDecimals, WAD_DECIMALS).wadDiv(
          scalePrice(currentPrice, priceDecimals, WAD_DECIMALS)
        );
    } else {
      // trigger/current - 1
      priceJump =
        scalePrice(triggerPrice, priceDecimals, WAD_DECIMALS).wadDiv(
          scalePrice(currentPrice, priceDecimals, WAD_DECIMALS)
        ) -
        WadRayMath.WAD;
    }

    uint8 slot = uint8((priceJump + _slotSize / 2) / _slotSize);

    if (slot >= PRICE_SLOTS) {
      return pdf[PRICE_SLOTS - 1];
    } else {
      return pdf[slot];
    }
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
    require(duration != 0, "|duration| < 1");
    _cdf[duration] = cdf;
  }

  /**
   * @dev Sets the tolerance for price age
   * @param oracleTolerance_ The new tolerance in seconds.
   */
  function setOracleTolerance(uint256 oracleTolerance_)
    external
    onlyComponentRole(ORACLE_ADMIN_ROLE)
    whenNotPaused
  {
    _oracleTolerance = oracleTolerance_;
  }

  function getCDF(int40 duration) external view returns (uint256[PRICE_SLOTS] memory) {
    return _cdf[duration];
  }

  function referenceOracle() external view override returns (AggregatorV3Interface) {
    return _referenceOracle;
  }

  function assetOracle() external view override returns (AggregatorV3Interface) {
    return _assetOracle;
  }

  function oracleTolerance() external view override returns (uint256) {
    return _oracleTolerance;
  }
}
