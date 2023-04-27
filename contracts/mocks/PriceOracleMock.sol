// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

contract PriceOracleMock is IPriceOracle {
  uint256 internal _price;

  constructor(uint256 price) {
    _price = price;
  }

  function getCurrentPrice() external view override returns (uint256) {
    // require(_price != 0, "Error, price can't be zero");
    return _price;
  }

  function setPrice(uint256 price_) external {
    _price = price_;
  }
}
