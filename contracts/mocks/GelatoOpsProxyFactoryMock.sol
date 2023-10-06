// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

// implement a dummy implementation of ../dependencies/gelato-v2/Types.sol:IAutomate that just accepts calls to createTask and emits an event with all details

import {IOpsProxyFactory} from "../dependencies/gelato-v2/Types.sol";

contract OpsProxyFactoryMock is IOpsProxyFactory {
  function getProxyOf(address) external pure override returns (address, bool) {
    return (address(0), false);
  }
}
