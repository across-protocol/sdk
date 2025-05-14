import { isDefined } from "./TypeGuards";
import { getCurrentTime } from "./TimeUtils";
import { CachingMechanismInterface } from "../interfaces";
import { shouldCache } from "./CachingUtils";
import { DEFAULT_CACHING_SAFE_LAG } from "../constants";

export type BlockFinderOpts = {
  highBlock?: number;
  highBlockOffset?: number;
  blockRange?: number;
};

export type BlockTimeAverage = {
  average: number;
  blockRange: number;
  timestamp: number;
};

export interface Block {
  hash: string;
  number: number;
  timestamp: number;
}

export type BlockFinderHints = {
  lowBlock?: number;
  highBlock?: number;
};

export abstract class BlockFinder<TBlock extends Block> {
  abstract getBlockForTimestamp(timestamp: number | string, hints: BlockFinderHints): Promise<TBlock>;
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
export async function getCachedBlockForTimestamp<TBlock extends Block>(
  chainId: number,
  timestamp: number,
  blockFinder: BlockFinder<TBlock>,
  cache?: CachingMechanismInterface,
  hints?: BlockFinderHints
): Promise<number> {
  // Resolve a convenience function to directly compute what we're
  // looking for.
  const resolver = async () => (await blockFinder.getBlockForTimestamp(timestamp, hints || {})).number;

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
