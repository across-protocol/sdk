//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

// This interface is expected to be implemented by any contract
// that expects to receive messages from the SpokePool.
// Retrieved from https://github.com/across-protocol/contracts-v2/blob/master/contracts/SpokePool.sol
interface AcrossMessageHandler {
  function handleAcrossMessage(
    address tokenSent,
    uint256 amount,
    bool fillCompleted,
    address relayer,
    bytes memory message
  ) external;
}

contract MockAcrossMessageContract is AcrossMessageHandler {
  function handleAcrossMessage(address, uint256, bool, address, bytes memory message) external view override {
    // For the case that we want to test a revert.
    // Let's also use a hash for more gas consumption.
    bytes memory revertMessage = bytes("REVERT");
    require(keccak256(message) != keccak256(revertMessage), "MockAcrossMessageContract: revert");

    // Iterate from 0 to 1000 to simulate a long-running operation.
    for (uint256 i = 0; i < 1000; i++) {
      // Do a bit of work.
      address(this).balance;
    }
  }
}
