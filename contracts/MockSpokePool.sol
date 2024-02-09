//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@across-protocol/contracts-v2/contracts/test/MockSpokePool.sol";

/**
 * @title MockSpokePool
 * @dev For some reason, the @openzeppelin/hardhat-upgrades plugin fails to find the MockSpokePool ABI unless
 * this contract is explicitly defined here.
 */
contract _MockSpokePool is MockSpokePool {
    /// @custom:oz-upgrades-unsafe-allow constructor
     constructor(address _wrappedNativeTokenAddress) MockSpokePool(_wrappedNativeTokenAddress) {} // solhint-disable-line no-empty-blocks 
     
    // Use this function to unit test that the SpokePoolClient can handle FundsDeposited, which was deprecated in 
    // the latest contracts-v2 SpokePool code. We need to support this for backwards compatibility.
    function depositV2(
        address recipient,
        address originToken,
        uint256 amount,
        uint256 destinationChainId,
        int64 relayerFeePct,
        uint32 quoteTimestamp,
        bytes memory message,
        uint256 maxCount
    ) external payable {
        emit FundsDeposited(
            amount,
            chainId(),
            destinationChainId,
            relayerFeePct,
            numberOfDeposits++,
            quoteTimestamp,
            originToken,
            recipient,
            msg.sender,
            message
        );
    }
}
