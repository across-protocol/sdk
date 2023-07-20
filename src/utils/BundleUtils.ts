import { AcrossConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import { CHAIN_ID_LIST_INDICES } from "../constants";
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
  chainIdListForBundleEvaluationBlockNumbers: number[] = CHAIN_ID_LIST_INDICES
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
  chainIdListForBundleEvaluationBlockNumbers: number[] = CHAIN_ID_LIST_INDICES
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

  // Get enabled chains for this bundle block range.
  // Don't let caller override the list of enabled chains when constructing an implied bundle block range,
  // since this function is designed to reconstruct a historical bundle block range.
  const enabledChains = configStoreClient.getEnabledChains(rootBundle.blockNumber, configStoreClient.enabledChainIds);

  return rootBundle.bundleEvaluationBlockNumbers.map((endBlock, i) => {
    const chainId = configStoreClient.enabledChainIds[i];
    const fromBlock = prevRootBundle?.bundleEvaluationBlockNumbers?.[i]
      ? prevRootBundle.bundleEvaluationBlockNumbers[i].toNumber() + 1
      : 0;
    if (!enabledChains.includes(chainId)) {
      return [endBlock.toNumber(), endBlock.toNumber()];
    }
    return [fromBlock, endBlock.toNumber()];
  });
}

// Return true if we won't be able to construct a root bundle for the bundle block ranges ("blockRanges") because
// the bundle wants to look up data for events that weren't in the spoke pool client's search range.
export function blockRangesAreInvalidForSpokeClients(
  spokePoolClients: Record<number, SpokePoolClient>,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[] = CHAIN_ID_LIST_INDICES
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
