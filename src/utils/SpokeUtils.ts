import { SpokePool } from "../typechain";

/**
 * Find the block range that contains the deposit ID. This is a binary search that searches for the block range
 * that contains the deposit ID.
 * @param targetDepositId The target deposit ID to search for.
 * @param initLow The initial lower bound of the block range to search.
 * @param initHigh The initial upper bound of the block range to search.
 * @param maxSearches The maximum number of searches to perform. This is used to prevent infinite loops.
 * @returns The block range that contains the deposit ID.
 * @note  // We want to find the block range that satisfies these conditions:
 *        // - the low block has deposit count <= targetDepositId
 *        // - the high block has a deposit count > targetDepositId.
 *        // This way the caller can search for a FundsDeposited event between [low, high] that will always
 *        // contain the event emitted when deposit ID was incremented to targetDepositId + 1. This is the same transaction
 *        // where the deposit with deposit ID = targetDepositId was created.
 */
export async function getBlockRangeForDepositId(
  targetDepositId: number,
  initLow: number,
  initHigh: number,
  maxSearches: number,
  spokePool: SpokePool,
  deploymentBlock = 0
): Promise<{
  low: number;
  high: number;
}> {
  // Define a mapping of block numbers to deposit IDs. This is used to cache the deposit ID at a block number
  // so we don't need to make an eth_call request to get the deposit ID at a block number more than once.
  const queriedIds: Record<number, number> = {};

  // Define a llambda function to get the deposit ID at a block number. This function will first check the
  // queriedIds cache to see if the deposit ID at the block number has already been queried. If not, it will
  // make an eth_call request to get the deposit ID at the block number. It will then cache the deposit ID
  // in the queriedIds cache.
  const _getDepositIdAtBlock = async (blockNumber: number): Promise<number> => {
    if (queriedIds[blockNumber] === undefined) {
      queriedIds[blockNumber] = await getDepositIdAtBlock(spokePool, blockNumber);
    }
    return queriedIds[blockNumber];
  };

  // Get the most recent block from the spoke pool contract, the deposit ID
  // at the low block, and the deposit ID at the high block in parallel.
  const [mostRecentBlockNumber, highestPossibleDepositIdInRange, lowestPossibleDepositIdInRange] = await Promise.all([
    spokePool.provider.getBlockNumber(),
    _getDepositIdAtBlock(initHigh),
    _getDepositIdAtBlock(Math.max(deploymentBlock, initLow - 1)),
  ]);
  // Set the initial high block to the most recent block number or the initial high block, whichever is smaller.
  initHigh = Math.min(initHigh, mostRecentBlockNumber);

  // Sanity check to ensure that initHigh is greater than or equal to initLow.
  if (initLow > initHigh) {
    throw new Error("Binary search failed because low > high");
  }

  // Sanity check to ensure that init Low is greater than or equal to zero.
  if (initLow < deploymentBlock) {
    throw new Error("Binary search failed because low must be >= deploymentBlock");
  }

  // Sanity check to ensure that maxSearches is greater than zero.
  if (maxSearches <= 0) {
    throw new Error("maxSearches must be > 0");
  }

  // Sanity check to ensure that deploymentBlock is greater than or equal to zero.
  if (deploymentBlock < 0) {
    throw new Error("deploymentBlock must be >= 0");
  }

  // If the deposit ID at the initial high block is less than the target deposit ID, then we know that
  // the target deposit ID must be greater than the initial high block, so we can throw an error.
  if (highestPossibleDepositIdInRange <= targetDepositId) {
    // initLow   = 5: Deposits Num: 10
    //                                     // targetId = 11  <- fail (triggers this error)          // 10 <= 11
    //                                     // targetId = 10  <- fail (triggers this error)          // 10 <= 10
    //                                     // targetId = 09  <- pass (does not trigger this error)  // 10 <= 09
    throw new Error(`Target depositId is greater than the initial high block (${targetDepositId} > ${initHigh})`);
  }

  // If the deposit ID at the initial low block is greater than the target deposit ID, then we know that
  // the target deposit ID must be less than the initial low block, so we can throw an error.
  if (lowestPossibleDepositIdInRange > targetDepositId) {
    // initLow   = 5: Deposits Num: 10
    // initLow-1 = 4: Deposits Num:  2
    //                                     // targetId = 1 <- fail (triggers this error)
    //                                     // targetId = 2 <- pass (does not trigger this error)
    //                                     // targetId = 3 <- pass (does not trigger this error)
    throw new Error(`Target depositId is less than the initial low block (${targetDepositId} > ${initLow})`);
  }

  // Define the low and high block numbers for the binary search.
  let low = initLow;
  let high = initHigh;

  // Define the number of searches performed so far.
  let searches = 0;

  do {
    // Resolve the mid point of the block range.
    const mid = Math.floor((low + high) / 2);

    // Get the deposit ID at the mid point.
    const midDepositId = await _getDepositIdAtBlock(mid);

    // Let's define the latest ID of the current midpoint block.
    const accountedIdByMidBlock = midDepositId - 1;

    // If our target deposit ID is less than the smallest range of our
    // midpoint deposit ID range, then we know that the target deposit ID
    // must be in the lower half of the block range.
    if (targetDepositId <= accountedIdByMidBlock) {
      high = mid;
    }
    // If our target deposit ID is greater than the largest range of our
    // midpoint deposit ID range, then we know that the target deposit ID
    // must be in the upper half of the block range.
    else {
      low = mid + 1;
    }

    // We want to iterate until we've either found the block range or we've
    // exceeded the maximum number of searches.
  } while (++searches <= maxSearches && low < high);

  // Sanity check to ensure that our low was not greater than our high.
  if (low > high) {
    throw new Error(`Binary search failed (${low} > ${high}). SHOULD NEVER HAPPEN (but here we are)`);
  }

  // We've either found the block range or we've exceeded the maximum number of searches.
  // In either case, the block range is [low, high] so we can return it.
  return { low, high };
}

/**
 * Finds the deposit id at a specific block number.
 * @param blockTag The block number to search for the deposit ID at.
 * @returns The deposit ID.
 */
export async function getDepositIdAtBlock(contract: SpokePool, blockTag: number): Promise<number> {
  const depositIdAtBlock = await contract.numberOfDeposits({ blockTag });
  // Sanity check to ensure that the deposit ID is an integer and is greater than or equal to zero.
  if (!Number.isInteger(depositIdAtBlock) || depositIdAtBlock < 0) {
    throw new Error("Invalid deposit count");
  }
  return depositIdAtBlock;
}
