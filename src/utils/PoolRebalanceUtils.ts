// This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
// when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
// (because we can't evaluate events in the future), and greater than the the expected start blocks, which are the

import { SpokePoolClient } from "../clients";
import { Clients } from "./TypeUtils";

// greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
export function getWidestPossibleExpectedBlockRange(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  spokeClients: { [chainId: number]: SpokePoolClient },
  endBlockBuffers: number[],
  clients: Clients,
  latestMainnetBlock: number,
  enabledChains: number[]
): number[][] {
  // We impose a buffer on the head of the chain to increase the probability that the received blocks are final.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  const latestPossibleBundleEndBlockNumbers = chainIdListForBundleEvaluationBlockNumbers.map(
    (chainId: number, index) =>
      spokeClients[chainId] && Math.max(spokeClients[chainId].latestBlockNumber - endBlockBuffers[index], 0)
  );
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => {
    const lastEndBlockForChain = clients.hubPoolClient.getLatestBundleEndBlockForChain(
      chainIdListForBundleEvaluationBlockNumbers,
      latestMainnetBlock,
      chainId
    );

    // If chain is disabled, re-use the latest bundle end block for the chain as both the start
    // and end block.
    if (!enabledChains.includes(chainId)) {
      return [lastEndBlockForChain, lastEndBlockForChain];
    } else {
      // If the latest block hasn't advanced enough from the previous proposed end block, then re-use it. It will
      // be regarded as disabled by the Dataworker clients. Otherwise, add 1 to the previous proposed end block.
      if (lastEndBlockForChain >= latestPossibleBundleEndBlockNumbers[index]) {
        // @dev: Without this check, then `getNextBundleStartBlockNumber` could return `latestBlock+1` even when the
        // latest block for the chain hasn't advanced, resulting in an invalid range being produced.
        return [lastEndBlockForChain, lastEndBlockForChain];
      } else {
        // Chain has advanced far enough including the buffer, return range from previous proposed end block + 1 to
        // latest block for chain minus buffer.
        return [
          clients.hubPoolClient.getNextBundleStartBlockNumber(
            chainIdListForBundleEvaluationBlockNumbers,
            latestMainnetBlock,
            chainId
          ),
          latestPossibleBundleEndBlockNumbers[index],
        ];
      }
    }
  });
}
