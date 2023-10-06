// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

// implement a dummy implementation of ../dependencies/gelato-v2/Types.sol:IAutomate that just accepts calls to createTask and emits an event with all details

import {IAutomate, ITaskTreasuryUpgradable, ModuleData} from "../dependencies/gelato-v2/Types.sol";

contract AutomateMock is IAutomate {
  address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
  uint256 internal constant GWEI = 1e9;

  event TaskCreated(
    address execAddress,
    bytes execDataOrSelector,
    ModuleData moduleData,
    address feeToken
  );

  address payable public gelato;

  constructor(address _gelato) {
    gelato = payable(_gelato);
  }

  function createTask(
    address execAddress,
    bytes calldata execDataOrSelector,
    ModuleData calldata moduleData,
    address feeToken
  ) external override returns (bytes32 taskId) {
    taskId = keccak256(abi.encode(execAddress, execDataOrSelector, moduleData, feeToken));
    emit TaskCreated(execAddress, execDataOrSelector, moduleData, feeToken);
  }

  function cancelTask(bytes32 taskId) external override {}

  function getFeeDetails() external pure override returns (uint256, address) {
    return (1337 * GWEI, address(ETH));
  }

  function taskTreasury() external pure override returns (ITaskTreasuryUpgradable) {
    return ITaskTreasuryUpgradable(address(0));
  }
}
