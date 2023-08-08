import { BlockFinder } from "@uma/financial-templates-lib";
import { providers } from "ethers";
import { Block } from "../interfaces";

/**
 * @notice Get the block number for a given timestamp fresh from on-chain data if not found in redis cache.
 * If redis cache is not available, then requests block from blockFinder.
 * @param chainId Chain to load block finder for.
 * @param timestamp Approximate timestamp of the to requested block number.
 * @param blockFinder Caller can optionally pass in a block finder object to use instead of creating a new one
 * or loading from cache. This is useful for testing primarily.
 * @returns Block number for the requested timestamp.
 */
export async function getBlockForTimestamp(
  chainId: number,
  timestamp: number,
  provider: providers.Provider
): Promise<number> {
  const blockFinder = new BlockFinder<Block>(provider.getBlock.bind(provider), [], chainId);
  return (await blockFinder.getBlockForTimestamp(timestamp)).number;
}
