import assert from "assert";
import type { Block, Provider } from "@ethersproject/abstract-provider";
import { clamp, sortedIndexBy } from "lodash";
import { getNetworkName } from "./NetworkUtils";
import { isDefined } from "./TypeGuards";
import { getCurrentTime } from "./TimeUtils";
import { CachingMechanismInterface } from "../interfaces";
import { shouldCache } from "./CachingUtils";
import { DEFAULT_CACHING_SAFE_LAG } from "../constants";

type Opts = {
  highBlock?: number;
  highBlockOffset?: number;
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

// Default offset to the high block number. This is subtracted from the block number of the high block
// when it is queried from the network, rather than having been specified by the caller. This is useful
// since the supplied Provider instance may be backed by multiple RPC providers, which can lead to some
// providers running slower than others and taking time to synchronise on the latest block.
const defaultHighBlockOffset = 10;

// Retain computations for 15 minutes.
const cacheTTL = 60 * 15;
const now = getCurrentTime(); // Seed the cache with initial values.
const blockTimes: { [chainId: number]: BlockTimeAverage } = {
  1: { average: 12.5, timestamp: now, blockRange: 1 },
  10: { average: 2, timestamp: now, blockRange: 1 },
  8453: { average: 2, timestamp: now, blockRange: 1 },
};

/**
 * @description Compute the average block time over a block range.
 * @returns Average number of seconds per block.
 */
export async function averageBlockTime(
  provider: Provider,
  { highBlock, highBlockOffset, blockRange }: Opts = {}
): Promise<Pick<BlockTimeAverage, "average" | "blockRange">> {
  // Does not block for StaticJsonRpcProvider.
  const chainId = (await provider.getNetwork()).chainId;

  const cache = blockTimes[chainId];
  const now = getCurrentTime();
  if (isDefined(cache) && now < cache.timestamp + cacheTTL) {
    return { average: cache.average, blockRange: cache.blockRange };
  }

  // If the caller was not specific about highBlock, resolve it via the RPC provider. Subtract an offset
  // to account for various RPC provider sync issues that might occur when querting the latest block.
  if (!isDefined(highBlock)) {
    highBlock = await provider.getBlockNumber();
    highBlock -= highBlockOffset ?? defaultHighBlockOffset;
  }
  blockRange ??= defaultBlockRange;

  const earliestBlockNumber = highBlock - blockRange;
  const [firstBlock, lastBlock] = await Promise.all([
    provider.getBlock(earliestBlockNumber),
    provider.getBlock(highBlock),
  ]);
  [firstBlock, lastBlock].forEach((block: Block | undefined) => {
    if (!isDefined(block?.timestamp)) {
      const network = getNetworkName(chainId);
      const blockNumber = block === firstBlock ? earliestBlockNumber : highBlock;
      throw new Error(`BlockFinder: Failed to fetch block ${blockNumber} on ${network}`);
    }
  });

  const average = (lastBlock.timestamp - firstBlock.timestamp) / blockRange;
  blockTimes[chainId] = { timestamp: now, average, blockRange };

  return { average, blockRange };
}

async function estimateBlocksElapsed(seconds: number, cushionPercentage = 0.0, provider: Provider): Promise<number> {
  const cushionMultiplier = cushionPercentage + 1.0;
  const { average } = await averageBlockTime(provider);
  return Math.floor((seconds * cushionMultiplier) / average);
}

export type BlockFinderHints = {
  lowBlock?: number;
  highBlock?: number;
};

export class BlockFinder {
  constructor(
    private readonly provider: Provider,
    private readonly blocks: Block[] = []
  ) {}

  /**
   * @notice Gets the latest block whose timestamp is <= the provided timestamp.
   * @param number Timestamp timestamp to search.
   * @param hints Optional low and high block to bound the search space.
   */
  public async getBlockForTimestamp(timestamp: number | string, hints: BlockFinderHints = {}): Promise<Block> {
    timestamp = Number(timestamp);
    assert(timestamp !== undefined && timestamp !== null, "timestamp must be provided");
    // If the last block we have stored is too early, grab the latest block.
    if (this.blocks.length === 0 || this.blocks[this.blocks.length - 1].timestamp < timestamp) {
      const block = await this.getLatestBlock();
      if (timestamp >= block.timestamp) return block;
    }

    // Prime the BlockFinder cache with any supplied hints.
    // If the hint is accurate, then this will bypass the subsequent estimation.
    await Promise.all(
      Object.values(hints)
        .filter((blockNumber) => isDefined(blockNumber))
        .map((blockNumber) => this.getBlock(blockNumber))
    );

    // Check the first block. If it's greater than our timestamp, we need to find an earlier block.
    if (this.blocks[0].timestamp > timestamp) {
      const initialBlock = this.blocks[0];
      // We use a 2x cushion to reduce the number of iterations in the following loop and increase the chance
      // that the first block we find sets a floor for the target timestamp. The loop converges on the correct block
      // slower than the following incremental search performed by `findBlock`, so we want to minimize the number of
      // loop iterations in favor of searching more blocks over the `findBlock` search.
      const cushion = 1;
      const incrementDistance = Math.max(
        // Ensure the increment block distance is _at least_ a single block to prevent an infinite loop.
        await estimateBlocksElapsed(initialBlock.timestamp - timestamp, cushion, this.provider),
        1
      );

      // Search backwards by a constant increment until we find a block before the timestamp or hit block 0.
      for (let multiplier = 1; ; multiplier++) {
        const distance = multiplier * incrementDistance;
        const blockNumber = Math.max(0, initialBlock.number - distance);
        const block = await this.getBlock(blockNumber);
        if (block.timestamp <= timestamp) break; // Found an earlier block.
        assert(blockNumber > 0, "timestamp is before block 0"); // Block 0 was not earlier than this timestamp. The row.
      }
    }

    // Find the index where the block would be inserted and use that as the end block (since it is >= the timestamp).
    const index = sortedIndexBy(this.blocks, { timestamp } as Block, "timestamp");
    return this.findBlock(this.blocks[index - 1], this.blocks[index], timestamp);
  }

  // Grabs the most recent block and caches it.
  private async getLatestBlock() {
    const block = await this.provider.getBlock("latest");
    const index = sortedIndexBy(this.blocks, block, "number");
    if (this.blocks[index]?.number !== block.number) this.blocks.splice(index, 0, block);
    return this.blocks[index];
  }

  // Grabs the block for a particular number and caches it.
  private async getBlock(number: number) {
    let index = sortedIndexBy(this.blocks, { number } as Block, "number");
    if (this.blocks[index]?.number === number) return this.blocks[index]; // Return early if block already exists.
    const block = await this.provider.getBlock(number);

    // Recompute the index after the async call since the state of this.blocks could have changed!
    index = sortedIndexBy(this.blocks, { number } as Block, "number");

    // Rerun this check to avoid duplicate insertion.
    if (this.blocks[index]?.number === number) return this.blocks[index];
    this.blocks.splice(index, 0, block); // A simple insert at index.
    return block;
  }

  // Return the latest block, between startBlock and endBlock, whose timestamp is <= timestamp.
  // Effectively, this is an interpolation search algorithm to minimize block requests.
  // Note: startBlock and endBlock _must_ be different blocks.
  private async findBlock(_startBlock: Block, _endBlock: Block, timestamp: number): Promise<Block> {
    const [startBlock, endBlock] = [_startBlock, _endBlock];
    // In the case of equality, the endBlock is expected to be passed as the one whose timestamp === the requested
    // timestamp.
    if (endBlock.timestamp === timestamp) return endBlock;

    // If there's no equality, but the blocks are adjacent, return the startBlock, since we want the returned block's
    // timestamp to be <= the requested timestamp.
    if (endBlock.number === startBlock.number + 1) return startBlock;

    assert(endBlock.number !== startBlock.number, "startBlock cannot equal endBlock");
    assert(
      timestamp < endBlock.timestamp && timestamp > startBlock.timestamp,
      "timestamp not in between start and end blocks"
    );

    // Interpolating the timestamp we're searching for to block numbers.
    const totalTimeDifference = endBlock.timestamp - startBlock.timestamp;
    const totalBlockDistance = endBlock.number - startBlock.number;
    const blockPercentile = (timestamp - startBlock.timestamp) / totalTimeDifference;
    const estimatedBlock = startBlock.number + Math.round(blockPercentile * totalBlockDistance);

    // Clamp ensures the estimated block is strictly greater than the start block and strictly less than the end block.
    const newBlock = await this.getBlock(clamp(estimatedBlock, startBlock.number + 1, endBlock.number - 1));

    // Depending on whether the new block is below or above the timestamp, narrow the search space accordingly.
    if (newBlock.timestamp < timestamp) {
      return this.findBlock(newBlock, endBlock, timestamp);
    } else {
      return this.findBlock(startBlock, newBlock, timestamp);
    }
  }
}

/**
 * @notice Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
 * If redis cache is not available, then requests block from blockFinder.
 * @param chainId Chain to load block finder for.
 * @param timestamp Approximate timestamp of the to requested block number.
 * @param blockFinder Caller can optionally pass in a block finder object to use instead of creating a new one
 * or loading from cache. This is useful for testing primarily.
 * @returns Block number for the requested timestamp.
 */
export async function getCachedBlockForTimestamp(
  chainId: number,
  timestamp: number,
  blockFinder: BlockFinder,
  cache?: CachingMechanismInterface,
  hints?: BlockFinderHints
): Promise<number> {
  // Resolve a convenience function to directly compute what we're
  // looking for.
  const resolver = async () => (await blockFinder.getBlockForTimestamp(timestamp, hints)).number;

  // If no redis client, then request block from blockFinder.
  if (!isDefined(cache)) {
    return resolver();
  }

  // Cache exists. We should first check if it's possible to retrieve the block number from cache.

  // Resolve the key for the block number.
  const key = `${chainId}_block_number_${timestamp}`;
  // See if it's even possible to retrieve the block number from cache.
  if (shouldCache(timestamp, getCurrentTime(), DEFAULT_CACHING_SAFE_LAG)) {
    // Attempt to retrieve the block number from cache.
    const result = await cache.get<string>(key);
    // If the block number is in cache, then return it.
    if (result !== null) {
      return parseInt(result);
    }
    // Otherwise, we need to resolve the block number and cache it.
    else {
      const blockNumber = await resolver();
      // Expire key after 90 days.
      await cache.set(key, blockNumber.toString(), 60 * 60 * 24 * 90); // 90 days
      return blockNumber;
    }
  }
  // It's too early to cache this key. Resolve the block number and return it.
  else {
    return resolver();
  }
}
