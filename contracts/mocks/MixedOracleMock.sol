// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ChainlinkPriceOracle} from "../ChainlinkPriceOracle.sol";
import {PriceOracleMock} from "./PriceOracleMock.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MixedOracleMock
 * @notice This contract is used on testnet to have control of the price for policy triggering.
 *         Once deployed the contract will use the defined chainlink oracle. If the owner sets a price != 0
 *         the contract will use that price instead of the chainlink oracle.
 */
contract MixedOracleMock is ChainlinkPriceOracle, PriceOracleMock, Ownable {
  constructor(
    AggregatorV3Interface assetOracle_,
    AggregatorV3Interface referenceOracle_,
    uint256 oracleTolerance_
  ) ChainlinkPriceOracle(assetOracle_, referenceOracle_, oracleTolerance_) PriceOracleMock(0) Ownable() {}

  function getCurrentPrice() public view override(ChainlinkPriceOracle, PriceOracleMock) returns (uint256) {
    if (_price == 0) {
      return ChainlinkPriceOracle.getCurrentPrice();
    } else {
      return PriceOracleMock.getCurrentPrice();
    }
  }

  function setPrice(uint256 price_) external override onlyOwner {
    _price = price_;
  }
}
