import assert from "assert";
import { clamp, sortedIndexBy } from "lodash";
import {
  BlockFinder,
  type Block,
  type BlockFinderOpts as Opts,
  type BlockTimeAverage,
  type BlockFinderHints,
} from "../../utils/BlockFinder";
import { isDefined } from "../../utils/TypeGuards";
import { getCurrentTime } from "../../utils/TimeUtils";
import { CHAIN_IDs } from "../../constants";
import { SVMProvider } from "./";

interface SVMBlock extends Block {}

const defaultHighBlockOffset = 10;

const defaultBlockRange = 120;
const cacheTTL = 60 * 15;
const blockTimes: { [chainId: number]: BlockTimeAverage } = {};

/**
 * @description Compute the average block time over a block range.
 * @returns Average number of seconds per block.
 */
export async function averageBlockTime(
  provider: SVMProvider,
  { highBlock, highBlockOffset, blockRange }: Opts = {}
): Promise<Pick<BlockTimeAverage, "average" | "blockRange">> {
  // @todo This may need to be expanded to work without assuming that chainId = CHAIN_IDs.SOLANA.
  const chainId = CHAIN_IDs.SOLANA;

  const cache = blockTimes[chainId];

  const now = getCurrentTime();
  if (isDefined(cache) && now < cache.timestamp + cacheTTL) {
    return { average: cache.average, blockRange: cache.blockRange };
  }

  // If the caller was not specific about highBlock, resolve it via the RPC provider. Subtract an offset
  // to account for various RPC provider sync issues that might occur when querting the latest block.
  if (!isDefined(highBlock)) {
    const highBlockBigInt = await provider.getSlot().send();
    highBlock = Number(highBlockBigInt);
    highBlock -= highBlockOffset ?? defaultHighBlockOffset;
  }
  blockRange ??= defaultBlockRange;

  const earliestBlockNumber = highBlock - blockRange;
  // At this point, we have a high slot and a low slot, but it is not guaranteed that a block exists for
  // either of these two slots. Therefore, we need to query blocks across this range and return the earliest
  // and latest valid block in this range.
  const slotRange = await provider.getBlocks(BigInt(earliestBlockNumber), BigInt(highBlock)).send();
  const [firstBlock, lastBlock] = await Promise.all([
    provider
      .getBlock(slotRange[0], {
        maxSupportedTransactionVersion: 0,
      })
      .send(),
    provider
      .getBlock(slotRange[slotRange.length - 1], {
        maxSupportedTransactionVersion: 0,
      })
      .send(),
  ]);
  // @todo Do not assert. Guarantee that blocks are here.
  assert(isDefined(firstBlock) && isDefined(lastBlock));

  const average = (Number(lastBlock.blockTime) - Number(firstBlock.blockTime)) / slotRange.length;
  blockTimes[chainId] = { timestamp: now, average, blockRange: slotRange.length };

  return { average, blockRange };
}

async function estimateBlocksElapsed(seconds: number, cushionPercentage = 0.0, provider: SVMProvider): Promise<number> {
  const cushionMultiplier = cushionPercentage + 1.0;
  const { average } = await averageBlockTime(provider);
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
   * @notice Gets the latest block whose timestamp is <= the provided timestamp.
   * @param number Timestamp timestamp to search.
   * @param hints Optional low and high block to bound the search space.
   */
  public async getBlockForTimestamp(timestamp: number | string, hints: BlockFinderHints = {}): Promise<SVMBlock> {
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
  private async getLatestBlock(): Promise<SVMBlock> {
    // We do not know the latest block given no context, so the strategy is to take some lookback,
    // get a range of blocks, and then return the latest block across that range.
    const latestFinalizedSlot = await this.provider.getSlot({ commitment: "finalized" }).send();
    const blockRange = await this.provider.getBlocks(latestFinalizedSlot).send();
    const _block = await this.provider
      .getBlock(blockRange[blockRange.length - 1], {
        maxSupportedTransactionVersion: 0,
      })
      .send();
    assert(isDefined(_block), `There has been no blocks since slot ${latestFinalizedSlot}`);

    // Cast the return type to an SVMBlock.
    const block: SVMBlock = {
      timestamp: Number(_block.blockTime),
      number: Number(_block.blockHeight),
      hash: String(_block.blockhash),
    };
    const index = sortedIndexBy(this.blocks, block, "number");
    if (this.blocks[index]?.number !== block.number) this.blocks.splice(index, 0, block);
    return this.blocks[index];
  }

  // Grabs the block for a particular number and caches it.
  // @dev since this is Solana, `number` does not represent the block number and instead represents the slot of the block. This means that it's
  // possible for there to be no block at the input number.
  // To mitigate this, `getBlock` returns the nearest block less than or equal to `number`.
  private async getBlock(number: number): Promise<SVMBlock> {
    let index = sortedIndexBy(this.blocks, { number } as Block, "number");
    if (this.blocks[index]?.number === number) return this.blocks[index]; // Return early if block already exists.
    const blocks = await this.provider.getBlocks(BigInt(number - defaultBlockRange), BigInt(number + 1)).send(); // Add search from [number-defaultBlockRange, number].
    const _block = await this.provider
      .getBlock(blocks[blocks.length - 1], {
        maxSupportedTransactionVersion: 0,
      })
      .send();
    assert(isDefined(_block));
    // Cast the return type to an SVMBlock.
    const block: SVMBlock = {
      timestamp: Number(_block.blockTime),
      number: Number(_block.blockHeight),
      hash: String(_block.blockhash),
    };

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
  private async findBlock(_startBlock: SVMBlock, _endBlock: SVMBlock, timestamp: number): Promise<SVMBlock> {
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
