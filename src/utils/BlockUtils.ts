import assert from "assert";
import type { Block, Provider } from "@ethersproject/abstract-provider";
import { clamp, sortedIndexBy } from "lodash";
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
  { latestBlockNumber, blockRange }: Opts = {}
): Promise<{ average: number; blockRange: number }> {
  // Does not block for StaticJsonRpcProvider.
  const chainId = (await provider.getNetwork()).chainId;

  const cache = blockTimes[chainId];
  const now = getCurrentTime();
  if (isDefined(cache) && now < cache.timestamp + cacheTTL) {
    return { average: cache.average, blockRange: cache.blockRange };
  }

  latestBlockNumber ??= await provider.getBlockNumber();
  blockRange ??= defaultBlockRange;

  const [firstBlock, lastBlock] = await Promise.all([
    provider.getBlock(latestBlockNumber - blockRange),
    provider.getBlock(latestBlockNumber),
  ]);
  const average = (lastBlock.timestamp - firstBlock.timestamp) / blockRange;
  blockTimes[chainId] = { timestamp: now, average, blockRange };

  return { average, blockRange };
}

async function estimateBlocksElapsed(seconds: number, cushionPercentage = 0.0, provider: Provider): Promise<number> {
  const cushionMultiplier = cushionPercentage + 1.0;
  const { average } = await averageBlockTime(provider);
  return Math.floor((seconds * cushionMultiplier) / average);
}

export class BlockFinder {
  constructor(
    private readonly provider: Provider,
    private readonly blocks: Block[] = []
  ) {}

  /**
   * @notice Gets the latest block whose timestamp is <= the provided timestamp.
   * @param {number} timestamp timestamp to search.
   */
  public async getBlockForTimestamp(timestamp: number | string): Promise<Block> {
    timestamp = Number(timestamp);
    assert(timestamp !== undefined && timestamp !== null, "timestamp must be provided");
    // If the last block we have stored is too early, grab the latest block.
    if (this.blocks.length === 0 || this.blocks[this.blocks.length - 1].timestamp < timestamp) {
      const block = await this.getLatestBlock();
      if (timestamp >= block.timestamp) return block;
    }

    // Check the first block. If it's grater than our timestamp, we need to find an earlier block.
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
