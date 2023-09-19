// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceRiskModule} from "../interfaces/IPriceRiskModule.sol";
import {IPolicyPool} from "@ensuro/core/contracts/interfaces/IPolicyPool.sol";
import {IPolicyHolder} from "@ensuro/core/contracts/interfaces/IPolicyHolder.sol";

/**
 * @title PayoutStrategyBase
 * @dev This is a base of contracts that will do something with the payout received from a policy. The contracts
 *      receives the NFT representing an Ensuro Policy and mints an NFT to original owner. That NFT now express how will
 *      receive the payout effect if the policy is triggered. Also the owner can choose to re-claim the policy.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract PayoutStrategyBase is
  Initializable,
  AccessControlUpgradeable,
  ERC721Upgradeable,
  UUPSUpgradeable,
  IPolicyHolder
{
  using SafeERC20 for IERC20Metadata;

  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyPool internal immutable _policyPool;

  modifier onlyPolicyPool() {
    require(
      _msgSender() == address(_policyPool),
      "PayoutStrategyBase: The caller must be the PolicyPool"
    );
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_) {
    require(
      address(policyPool_) != address(0),
      "PayoutStrategyBase: policyPool_ cannot be the zero address"
    );
    _policyPool = policyPool_;
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PayoutStrategyBase_init(
    string memory name_,
    string memory symbol_,
    address admin
  ) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __AccessControl_init();
    __ERC721_init(name_, symbol_);
    __PayoutStrategyBase_init_unchained(admin);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PayoutStrategyBase_init_unchained(address admin) internal onlyInitializing {
    // optional admin
    if (admin != address(0)) {
      _setupRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // Infinite approval, so we don't need to approve again for each acquired policy
    _policyPool.currency().approve(address(_policyPool), type(uint256).max);
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole(GUARDIAN_ROLE) {}

  function supportsInterface(bytes4 interfaceId)
    public
    view
    virtual
    override(AccessControlUpgradeable, ERC721Upgradeable)
    returns (bool)
  {
    return
      AccessControlUpgradeable.supportsInterface(interfaceId) ||
      ERC721Upgradeable.supportsInterface(interfaceId) ||
      interfaceId == type(IPolicyHolder).interfaceId;
  }

  function onERC721Received(
    address, // operator is the risk module that called newPolicy in the PolicyPool. Ignored for now,
    // perhaps in the future we can check is a PriceRiskModule
    address from,
    uint256 tokenId,
    bytes calldata data
  ) external override onlyPolicyPool returns (bytes4) {
    if (from != address(0)) {
      // I'm receiving a transfer, so I mint a token to the sender
      _safeMint(from, tokenId, data);
    }
    return IERC721Receiver.onERC721Received.selector;
  }

  function onPayoutReceived(
    address, // operator - ignored
    address, // from - Must be the PolicyPool, ignored too. Not too relevant this parameter
    uint256 tokenId,
    uint256 amount
  ) external override onlyPolicyPool returns (bytes4) {
    _handlePayout(ownerOf(tokenId), amount); // using ownerOf, it will revert if the owner doesn't exists, but
    // shouldn't happen.
    return IPolicyHolder.onPayoutReceived.selector;
  }

  function onPolicyExpired(
    address,
    address,
    uint256
  ) external view override onlyPolicyPool returns (bytes4) {
    // We don't do anything for now, in the future perhaps we can implement auto-renew.
    // TODO: should we burn the NFT?
    return IPolicyHolder.onPolicyExpired.selector;
  }

  function recoverPolicy(uint256 policyId) external {
    require(
      ownerOf(policyId) == _msgSender(),
      "PayoutStrategyBase: you must own the NFT to recover the policy"
    );
    // The following check is not needed since the contract logic should take care this always happens
    // require(_policyPool.ownerOf(policyId) == address(this));
    _burn(policyId);
    IERC721(address(_policyPool)).safeTransferFrom(address(this), _msgSender(), policyId);
  }

  /**
   * @dev Creates a new policy in a given PriceRiskModule
   *
   * Requirements:
   * - The oracle(s) are functional, returning non zero values and updated after (block.timestamp - oracleTolerance())
   * - The price jump is supported (_cdf[duration][priceJump] != 0)
   * - Spending approval granted to this contract
   *
   * @param riskModule   The PriceRiskModule where the policy will be created
   * @param triggerPrice The price at which the policy should trigger.
   *                     If referenceOracle() != address(0), the price is expressed in terms of the reference asset,
   *                     with the same decimals as reported by the reference oracle
   *                     If referenceOracle() == address(0), the price is expressed in the denomination
   *                     of assetOracle(), with the same decimals.
   * @param lower If true -> triggers if the price is lower, If false -> triggers if the price is higher
   * @param payout Expressed in policyPool.currency()
   * @param expiration The policy expiration timestamp
   * @param onBehalfOf The address that will own the new policy
   * @return policyId
   */
  function newPolicy(
    IPriceRiskModule riskModule,
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration,
    address onBehalfOf
  ) public returns (uint256 policyId) {
    (uint256 premium, ) = riskModule.pricePolicy(triggerPrice, lower, payout, expiration);
    require(premium != 0, "PayoutStrategyBase: premium = 0, policy not supported");
    _policyPool.currency().safeTransferFrom(_msgSender(), address(this), premium);
    policyId = riskModule.newPolicy(triggerPrice, lower, payout, expiration, address(this));
    _safeMint(onBehalfOf, policyId, "");
    return policyId;
  }

  function newPolicyWithPermit(
    IPriceRiskModule riskModule,
    uint256 triggerPrice,
    bool lower,
    uint256 payout,
    uint40 expiration,
    address onBehalfOf,
    uint256 permitValue,
    uint256 permitDeadline,
    uint8 permitV,
    bytes32 permitR,
    bytes32 permitS
  ) public returns (uint256 policyId) {
    IERC20Permit(address(_policyPool.currency())).permit(
      _msgSender(),
      address(this),
      permitValue,
      permitDeadline,
      permitV,
      permitR,
      permitS
    );
    return newPolicy(riskModule, triggerPrice, lower, payout, expiration, onBehalfOf);
  }

  function _handlePayout(address receiver, uint256 amount) internal virtual;
}
