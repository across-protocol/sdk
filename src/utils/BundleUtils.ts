import { AcrossConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import { ProposedRootBundle } from "../interfaces";

/**
 * Return block number for `chain` in `bundleEvaluationBlockNumbers` using the mapping
 * in `chainIdListForBundleEvaluationBlockNumbers` to figure out which index in `bundleEvaluationBlockNumbers`
 * the block for `chain` is
 * @param bundleEvaluationBlockNumbers Usually, the bundle end blocks proposed in a root bundle.
 * @param chain The chain to look up block for
 * @param chainIdListForBundleEvaluationBlockNumbers The hardcoded sequence of chain IDs. For example:
 * [1, 10, 137, 288, 42161] implies that if we're looking for the block for chain 137, it's at index 2 in
 * `bundleEvaluationBlockNumbers`.
 * @returns The block for `chain` in `bundleEvaluationBlockNumbers`.
 */
export function getBlockForChain(
  bundleEvaluationBlockNumbers: number[],
  chain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number {
  const indexForChain = chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
  if (indexForChain === -1) {
    throw new Error(`Could not find chain ${chain} in chain ID list ${chainIdListForBundleEvaluationBlockNumbers}`);
  }
  const blockForChain = bundleEvaluationBlockNumbers[indexForChain];
  if (blockForChain === undefined) {
    throw new Error(`Invalid block range for chain ${chain}`);
  }
  return blockForChain;
}

/**
 * Similar concept as `getBlockForChain`, but returns the block range for `chain` in `blockRanges`.
 * @param blockRanges
 * @param chain
 * @param chainIdListForBundleEvaluationBlockNumbers
 * @returns
 */
export function getBlockRangeForChain(
  blockRanges: number[][],
  chain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number[] {
  const indexForChain = chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
  if (indexForChain === -1) {
    throw new Error(`Could not find chain ${chain} in chain ID list ${chainIdListForBundleEvaluationBlockNumbers}`);
  }
  const blockRangeForChain = blockRanges[indexForChain];
  if (!blockRangeForChain || blockRangeForChain.length !== 2) {
    throw new Error(`Invalid block range for chain ${chain}`);
  }
  return blockRangeForChain;
}

/**
 * Return bundle block range for `rootBundle` whose bundle end blocks were included in the proposal.
 * This amounts to reconstructing the bundle range start block.
 * @param rootBundle Root bundle to return bundle block range for
 * @returns blockRanges: number[][], [[startBlock, endBlock], [startBlock, endBlock], ...]
 */
export function getImpliedBundleBlockRanges(
  hubPoolClient: HubPoolClient,
  configStoreClient: AcrossConfigStoreClient,
  rootBundle: ProposedRootBundle
): number[][] {
  const prevRootBundle = hubPoolClient.getLatestFullyExecutedRootBundle(rootBundle.blockNumber);
  // If chain is disabled for this bundle block range, end block should be same as previous bundle.
  // Otherwise the range should be previous bundle's endBlock + 1 to current bundle's end block.

  // Get enabled chains at the mainnet start block of the current root bundle.
  // We'll check each chain represented in the bundleEvaluationBlockNumbers to see if it's enabled and
  // use that to determine the implied block range.
  const mainnetStartBlock = prevRootBundle?.bundleEvaluationBlockNumbers[0].toNumber() ?? 0;
  const enabledChainsAtMainnetStartBlock = configStoreClient.getEnabledChains(mainnetStartBlock);

  // Load all chain indices in order to map bundle evaluation block numbers to enabled chains list.
  const chainIdIndices = configStoreClient.getChainIdIndicesForBlock(rootBundle.blockNumber);
  const result = rootBundle.bundleEvaluationBlockNumbers.map((endBlock, i) => {
    const fromBlock = prevRootBundle?.bundleEvaluationBlockNumbers?.[i]
      ? prevRootBundle.bundleEvaluationBlockNumbers[i].toNumber() + 1
      : 0;
    const chainId = chainIdIndices[i];
    if (!enabledChainsAtMainnetStartBlock.includes(chainId)) {
      return [endBlock.toNumber(), endBlock.toNumber()];
    }
    return [fromBlock, endBlock.toNumber()];
  });

  // Lastly, sanity check the results to catch errors early:
  // 1. If the chain is enabled, the start block should be strictly less than to the end block.
  // 2. If the chain is disabled, the start block should be equal to the end block.
  result.forEach(([start, end], i) => {
    const chainId = chainIdIndices[i];
    if (enabledChainsAtMainnetStartBlock.includes(chainId)) {
      if (start >= end) {
        throw new Error(
          `Invalid block range for enabled chain ${chainId}: start block ${start} is greater than or equal to end block ${end}`
        );
      }
    } else {
      if (start !== end) {
        throw new Error(
          `Invalid block range for disabled chain ${chainId}: start block ${start} is not equal to end block ${end}`
        );
      }
    }
  });

  return result;
}

// Return true if we won't be able to construct a root bundle for the bundle block ranges ("blockRanges") because
// the bundle wants to look up data for events that weren't in the spoke pool client's search range.
export function blockRangesAreInvalidForSpokeClients(
  spokePoolClients: Record<number, SpokePoolClient>,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[]
): boolean {
  if (blockRanges.length !== chainIdListForBundleEvaluationBlockNumbers.length) {
    throw new Error("DataworkerUtils#blockRangesAreInvalidForSpokeClients: Invalid bundle block range length");
  }
  return chainIdListForBundleEvaluationBlockNumbers.some((chainId) => {
    const blockRangeForChain = getBlockRangeForChain(
      blockRanges,
      Number(chainId),
      chainIdListForBundleEvaluationBlockNumbers
    );
    if (isNaN(blockRangeForChain[1]) || isNaN(blockRangeForChain[0])) {
      return true;
    }
    // If block range is 0 then chain is disabled, we don't need to query events for this chain.
    if (blockRangeForChain[1] === blockRangeForChain[0]) {
      return false;
    }

    // If spoke pool client doesn't exist for enabled chain then we clearly cannot query events for this chain.
    if (spokePoolClients[chainId] === undefined) {
      return true;
    }

    const clientLastBlockQueried =
      spokePoolClients[chainId].eventSearchConfig.toBlock ?? spokePoolClients[chainId].latestBlockNumber;
    const bundleRangeToBlock = blockRangeForChain[1];

    // Note: Math.max the from block with the deployment block of the spoke pool to handle the edge case for the first
    // bundle that set its start blocks equal 0.
    const bundleRangeFromBlock = Math.max(spokePoolClients[chainId].deploymentBlock, blockRangeForChain[0]);
    const earliestSpokePoolClientBlockSearched = spokePoolClients[chainId].eventSearchConfig.fromBlock;
    return bundleRangeFromBlock <= earliestSpokePoolClientBlockSearched || bundleRangeToBlock > clientLastBlockQueried;
  });
}
