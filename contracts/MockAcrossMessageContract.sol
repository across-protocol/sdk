//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

// This interface is expected to be implemented by any contract
// that expects to receive messages from the SpokePool.
// Retrieved from https://github.com/across-protocol/contracts/blob/master/contracts/SpokePool.sol
interface AcrossMessageHandler {
  function handleV3AcrossMessage(address, uint256, address, bytes memory message) external;
}

contract MockAcrossMessageContract is AcrossMessageHandler {
  function handleV3AcrossMessage(address, uint256, address, bytes memory message) external virtual override {
    // For the case that we want to test a revert.
    require(keccak256(message) != keccak256(bytes("REVERT")), "MockAcrossMessageContract: revert");

    // Iterate from 0 to 1000 to simulate a long-running operation.
    for (uint256 i = 0; i < 1000; i++) {
      // Do a bit of work.
    }
  }
}
