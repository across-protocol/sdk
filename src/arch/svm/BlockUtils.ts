import assert from "assert";
import { clamp, sortedIndexBy } from "lodash";
import { BlockFinder, type Block, type BlockTimeAverage, type BlockFinderHints } from "../../utils/BlockFinder";
import { isDefined } from "../../utils/TypeGuards";
import { getCurrentTime } from "../../utils/TimeUtils";
import { CHAIN_IDs } from "../../constants";
import { SVMProvider } from "./";
import { getTimestampForSlot } from "./SpokeUtils";

interface SVMBlock extends Block {}

const now = getCurrentTime();
const averageBlockTimes: { [chainId: number]: BlockTimeAverage } = {
  [CHAIN_IDs.SOLANA]: { average: 0.4, timestamp: now, blockRange: 1 },
};

/**
 * @description Compute the average slot time over a slot range.
 * @dev Solana slots are all defined to be ~400ms away from each other += a small deviation, so we can hardcode this.
 * @returns Average number of seconds per slot
 */
export function averageBlockTime(): Pick<BlockTimeAverage, "average" | "blockRange"> {
  // @todo This may need to be expanded to work without assuming that chainId = CHAIN_IDs.SOLANA.
  return averageBlockTimes[CHAIN_IDs.SOLANA];
}

async function estimateBlocksElapsed(
  seconds: number,
  cushionPercentage = 0.0,
  _provider: SVMProvider
): Promise<number> {
  const cushionMultiplier = cushionPercentage + 1.0;
  const { average } = await averageBlockTime();
  return Math.floor((seconds * cushionMultiplier) / average);
}

export class SVMBlockFinder extends BlockFinder<SVMBlock> {
  constructor(
    private readonly provider: SVMProvider,
    private readonly blocks: SVMBlock[] = []
  ) {
    super();
  }

  /**
   * @notice Gets the latest slot whose timestamp is <= the provided timestamp.
   * @param number Timestamp timestamp to search.
   * @param hints Optional low and high slot to bound the search space.
   */
  public async getBlockForTimestamp(timestamp: number | string, hints: BlockFinderHints = {}): Promise<SVMBlock> {
    timestamp = Number(timestamp);
    assert(timestamp !== undefined && timestamp !== null, "timestamp must be provided");
    // If the last slot we have stored is too early, grab the latest slot.
    if (this.blocks.length === 0 || this.blocks[this.blocks.length - 1].timestamp < timestamp) {
      const block = await this.getLatestBlock();
      if (timestamp >= block.timestamp) return block;
    }

    // Prime the BlockFinder cache with any supplied hints.
    // If the hint is accurate, then this will bypass the subsequent estimation.
    await Promise.all(
      Object.values(hints)
        .filter(isDefined)
        .map((blockNumber) => this.getBlock(blockNumber))
    );

    // Check the first slot. If it's greater than our timestamp, we need to find an earlier slot.
    if (this.blocks[0].timestamp > timestamp) {
      const initialBlock = this.blocks[0];
      // We use a 2x cushion to reduce the number of iterations in the following loop and increase the chance
      // that the first slot we find sets a floor for the target timestamp. The loop converges on the correct slot
      // slower than the following incremental search performed by `findBlock`, so we want to minimize the number of
      // loop iterations in favor of searching more slots over the `findBlock` search.
      const cushion = 1;
      const incrementDistance = Math.max(
        // Ensure the increment slot distance is _at least_ a single slot to prevent an infinite loop.
        await estimateBlocksElapsed(initialBlock.timestamp - timestamp, cushion, this.provider),
        1
      );

      // Search backwards by a constant increment until we find a slot before the timestamp or hit slot 0.
      for (let multiplier = 1; ; multiplier++) {
        const distance = multiplier * incrementDistance;
        const blockNumber = Math.max(0, initialBlock.number - distance);
        const block = await this.getBlock(blockNumber);
        if (block.timestamp <= timestamp) break; // Found an earlier block.
        assert(blockNumber > 0, "timestamp is before block 0");
      }
    }

    // Find the index where the slot would be inserted and use that as the end slot (since it is >= the timestamp).
    const index = sortedIndexBy(this.blocks, { timestamp } as Block, "timestamp");
    return this.findBlock(this.blocks[index - 1], this.blocks[index], timestamp);
  }

  // Grabs the most recent slot and caches it.
  private async getLatestBlock(): Promise<SVMBlock> {
    let latestSlot: bigint;
    let estimatedSlotTime: number | undefined = undefined;

    // Iterate backwards until we find a slot with a block.
    do {
      latestSlot = await this.provider.getSlot().send();
      estimatedSlotTime = await getTimestampForSlot(this.provider, latestSlot);
    } while (!isDefined(estimatedSlotTime) && --latestSlot);

    // Cast the return type to an SVMBlock.
    const block: SVMBlock = {
      timestamp: Number(estimatedSlotTime),
      number: Number(latestSlot),
    };
    const index = sortedIndexBy(this.blocks, block, "number");
    if (this.blocks[index]?.number !== block.number) this.blocks.splice(index, 0, block);
    return this.blocks[index];
  }

  // Grabs the slot for a particular number and caches it.
  private async getBlock(number: number): Promise<SVMBlock> {
    let index = sortedIndexBy(this.blocks, { number } as Block, "number");
    if (this.blocks[index]?.number === number) return this.blocks[index]; // Return early if block already exists.

    const estimatedSlotTime = await this.provider.getBlockTime(BigInt(number)).send();
    // Cast the return type to an SVMBlock.
    const block: SVMBlock = {
      timestamp: Number(estimatedSlotTime),
      number,
    };

    // Recompute the index after the async call since the state of this.blocks could have changed!
    index = sortedIndexBy(this.blocks, { number } as Block, "number");

    // Rerun this check to avoid duplicate insertion.
    if (this.blocks[index]?.number === number) return this.blocks[index];
    this.blocks.splice(index, 0, block); // A simple insert at index.
    return block;
  }

  // Return the latest slot, between startSlot and endSlot, whose timestamp is <= timestamp.
  // Effectively, this is an interpolation search algorithm to minimize slot requests.
  // Note: startSlot and endSlot _must_ be different slots.
  private async findBlock(_startSlot: SVMBlock, _endSlot: SVMBlock, timestamp: number): Promise<SVMBlock> {
    const [startBlock, endBlock] = [_startSlot, _endSlot];
    // In the case of equality, the endBlock is expected to be passed as the one whose timestamp === the requested
    // timestamp.
    if (endBlock.timestamp === timestamp) return endBlock;

    // If there's no equality, but the blocks are adjacent, return the startBlock, since we want the returned slot's
    // timestamp to be <= the requested timestamp.
    if (endBlock.number === startBlock.number + 1) return startBlock;

    assert(endBlock.number !== startBlock.number, "startBlock cannot equal endBlock");
    assert(
      timestamp < endBlock.timestamp && timestamp > startBlock.timestamp,
      "timestamp not in between start and end blocks"
    );

    // Interpolating the timestamp we're searching for to slot numbers.
    const totalTimeDifference = endBlock.timestamp - startBlock.timestamp;
    const totalBlockDistance = endBlock.number - startBlock.number;
    const blockPercentile = (timestamp - startBlock.timestamp) / totalTimeDifference;
    const estimatedBlock = startBlock.number + Math.round(blockPercentile * totalBlockDistance);

    // Clamp ensures the estimated slot is strictly greater than the start slot and strictly less than the end slot.
    const newBlock = await this.getBlock(clamp(estimatedBlock, startBlock.number + 1, endBlock.number - 1));

    // Depending on whether the new slot is below or above the timestamp, narrow the search space accordingly.
    if (newBlock.timestamp < timestamp) {
      return this.findBlock(newBlock, endBlock, timestamp);
    } else {
      return this.findBlock(startBlock, newBlock, timestamp);
    }
  }
}
