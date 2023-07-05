import { AcrossConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import { ProposedRootBundle } from "../interfaces";

type SpokePoolClientsByChain = Record<string, SpokePoolClient>;

export function getEndBlockBuffers(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  blockRangeEndBlockBuffer: { [chainId: number]: number }
): number[] {
  // These buffers can be configured by the bot runner. They have two use cases:
  // 1) Validate the end blocks specified in the pending root bundle. If the end block is greater than the latest
  // block for its chain, then we should dispute the bundle because we can't look up events in the future for that
  // chain. However, there are some cases where the proposer's node for that chain is returning a higher HEAD block
  // than the bot-runner is seeing, so we can use this buffer to allow the proposer some margin of error. If
  // the bundle end block is less than HEAD but within this buffer, then we won't dispute and we'll just exit
  // early from this function.
  // 2) Subtract from the latest block in a new root bundle proposal. This can be used to reduce the chance that
  // bot runs using different providers see different contract state close to the HEAD block for a chain.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) => blockRangeEndBlockBuffer[chainId] ?? 0);
}

export function getBlockRangeForChain(
  blockRange: number[][],
  chain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number[] {
  const indexForChain = chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
  if (indexForChain === -1) {
    throw new Error(`Could not find chain ${chain} in chain ID list ${chainIdListForBundleEvaluationBlockNumbers}`);
  }
  const blockRangeForChain = blockRange[indexForChain];
  if (!blockRangeForChain || blockRangeForChain.length !== 2) {
    throw new Error(`Invalid block range for chain ${chain}`);
  }
  return blockRangeForChain;
}

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
 * Return bundle block range for `rootBundle` whose bundle end blocks were included in the proposal.
 * This amounts to reconstructing the bundle range start block.
 * @param rootBundle Root bundle to return bundle block range for
 * @returns blockRanges: number[][], [[startBlock, endBlock], [startBlock, endBlock], ...]
 */
export function getImpliedBundleBlockRanges(
  hubPoolClient: HubPoolClient,
  configStoreClient: AcrossConfigStoreClient,
  rootBundle: ProposedRootBundle,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number[][] {
  const prevRootBundle = hubPoolClient.getLatestFullyExecutedRootBundle(rootBundle.blockNumber);
  // If chain is disabled for this bundle block range, end block should be same as previous bundle.
  // Otherwise the range should be previous bundle's endBlock + 1 to current bundle's end block.

  // Get enabled chains for this bundle block range.
  // Don't let caller override the list of enabled chains when constructing an implied bundle block range,
  // since this function is designed to reconstruct a historical bundle block range.
  const enabledChains = configStoreClient.getEnabledChains(
    getBlockForChain(
      rootBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
      hubPoolClient.chainId,
      chainIdListForBundleEvaluationBlockNumbers
    ),
    chainIdListForBundleEvaluationBlockNumbers
  );

  return rootBundle.bundleEvaluationBlockNumbers.map((endBlock, i) => {
    const chainId = chainIdListForBundleEvaluationBlockNumbers[i];
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
  spokePoolClients: SpokePoolClientsByChain,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  latestInvalidBundleStartBlock: { [chainId: number]: number }
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
    // If block range is 0 then chain is disabled, we don't need to query events for this chain.
    if (isNaN(blockRangeForChain[1]) || isNaN(blockRangeForChain[0])) {
      return true;
    }
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
    return (
      bundleRangeFromBlock <= latestInvalidBundleStartBlock[chainId] || bundleRangeToBlock > clientLastBlockQueried
    );
  });
}
