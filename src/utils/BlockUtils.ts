import { providers } from "ethers";
import { isDefined } from "./TypeGuards";
import { getCurrentTime } from "./TimeUtils";

type Opts = {
  latestBlockNumber?: number;
  blockRange?: number;
};

type BlockTimeAverage = {
  average: number;
  blockRange: number;
  timestamp: number;
};

// Archive requests typically commence at 128 blocks past the head of the chain.
// Round down to 120 blocks to avoid slipping into archive territory.
const defaultBlockRange = 120;

// Retain computations for 15 minutes.
const cacheTTL = 60 * 15;
const blockTimes: { [chainId: number]: BlockTimeAverage } = {};

/**
 * @description Compute the average block time over a block range.
 * @returns Average number of seconds per block.
 */
export async function averageBlockTime(
  provider: providers.Provider,
  { latestBlockNumber, blockRange }: Opts = {}
): Promise<{ average: number; blockRange: number }> {
  // Does not block for StaticJsonRpcProvider.
  const chainId = (await provider.getNetwork()).chainId;

  const cache = blockTimes[chainId];
  const now = getCurrentTime();
  if (isDefined(cache) && now < cache.timestamp + cacheTTL) {
    return { average: cache.average, blockRange: cache.blockRange };
  }

  latestBlockNumber = latestBlockNumber ?? (await provider.getBlockNumber());
  blockRange = blockRange ?? defaultBlockRange;

  const [firstBlock, lastBlock] = await Promise.all([
    provider.getBlock(latestBlockNumber - blockRange),
    provider.getBlock(latestBlockNumber),
  ]);
  const average = (lastBlock.timestamp - firstBlock.timestamp) / blockRange;
  blockTimes[chainId] = { timestamp: now, average, blockRange };

  return { average, blockRange };
}
