import assert from "assert";
import { BigNumber, Contract, utils as ethersUtils } from "ethers";
import { FillStatus, RelayData, V2RelayData, V3RelayData } from "../interfaces";
import { SpokePoolClient } from "../clients";
import { bnZero } from "./BigNumberUtils";
import { isDefined } from "./TypeGuards";
import { getRelayDataOutputAmount, isV2RelayData } from "./V3Utils";
import { getNetworkName } from "./NetworkUtils";

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
  spokePool: SpokePoolClient
): Promise<{
  low: number;
  high: number;
}> {
  // Resolve the deployment block number.
  const deploymentBlock = spokePool.deploymentBlock;

  // Set the initial high block to the most recent block number or the initial high block, whichever is smaller.
  initHigh = Math.min(initHigh, spokePool.latestBlockSearched);

  // We will now set a list of sanity checks to ensure that the binary search will not fail
  // due to invalid input parameters.
  // If any of these sanity checks fail, then we will throw an error.
  (
    [
      // Sanity check to ensure that the spoke pool client is updated
      [spokePool.isUpdated, "Spoke pool client is not updated"],
      // Sanity check to ensure that initHigh is greater than or equal to initLow.
      [initLow <= initHigh, "Binary search failed because low > high"],
      // Sanity check to ensure that init Low is greater than or equal to zero.
      [initLow >= deploymentBlock, "Binary search failed because low must be >= deploymentBlock"],
      // Sanity check to ensure that maxSearches is greater than zero.
      [maxSearches > 0, "maxSearches must be > 0"],
      // Sanity check to ensure that deploymentBlock is greater than or equal to zero.
      [deploymentBlock >= 0, "deploymentBlock must be >= 0"],
    ] as [boolean, string][]
  ).forEach(([condition, errorMessage]) => {
    // If the condition is false, then we will throw an error.
    if (!condition) {
      throw new Error(errorMessage);
    }
  });

  // Define a mapping of block numbers to number of deposits at that block. This saves repeated lookups.
  const queriedIds: Record<number, number> = {};

  // Define a llambda function to get the deposit ID at a block number. This function will first check the
  // queriedIds cache to see if the deposit ID at the block number has already been queried. If not, it will
  // make an eth_call request to get the deposit ID at the block number. It will then cache the deposit ID
  // in the queriedIds cache.
  const _getDepositIdAtBlock = async (blockNumber: number): Promise<number> => {
    queriedIds[blockNumber] ??= await spokePool._getDepositIdAtBlock(blockNumber);
    return queriedIds[blockNumber];
  };

  // Get the the deposit ID at the low block, and the deposit ID at the high block in parallel.
  const [highestDepositIdInRange, lowestDepositIdInRange] = await Promise.all([
    _getDepositIdAtBlock(initHigh),
    _getDepositIdAtBlock(Math.max(deploymentBlock, initLow - 1)),
  ]);

  // If the deposit ID at the initial high block is less than the target deposit ID, then we know that
  // the target deposit ID must be greater than the initial high block, so we can throw an error.
  if (highestDepositIdInRange <= targetDepositId) {
    // initLow   = 5: Deposits Num: 10
    //                                     // targetId = 11  <- fail (triggers this error)          // 10 <= 11
    //                                     // targetId = 10  <- fail (triggers this error)          // 10 <= 10
    //                                     // targetId = 09  <- pass (does not trigger this error)  // 10 <= 09
    throw new Error(
      `Target depositId is greater than the initial high block (${targetDepositId} > ${highestDepositIdInRange})`
    );
  }

  // If the deposit ID at the initial low block is greater than the target deposit ID, then we know that
  // the target deposit ID must be less than the initial low block, so we can throw an error.
  if (lowestDepositIdInRange > targetDepositId) {
    // initLow   = 5: Deposits Num: 10
    // initLow-1 = 4: Deposits Num:  2
    //                                     // targetId = 1 <- fail (triggers this error)
    //                                     // targetId = 2 <- pass (does not trigger this error)
    //                                     // targetId = 3 <- pass (does not trigger this error)
    throw new Error(
      `Target depositId is less than the initial low block (${targetDepositId} > ${lowestDepositIdInRange})`
    );
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
export async function getDepositIdAtBlock(contract: Contract, blockTag: number): Promise<number> {
  const depositIdAtBlock = await contract.numberOfDeposits({ blockTag });
  // Sanity check to ensure that the deposit ID is an integer and is greater than or equal to zero.
  if (!Number.isInteger(depositIdAtBlock) || depositIdAtBlock < 0) {
    throw new Error("Invalid deposit count");
  }
  return depositIdAtBlock;
}

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @param relayData RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
export function getRelayDataHash(relayData: RelayData, destinationChainId?: number): string {
  if (isV2RelayData(relayData)) {
    // If destinationChainId was supplied, ensure it matches relayData.
    assert(!isDefined(destinationChainId) || destinationChainId === relayData.destinationChainId);
    return getV2RelayHash(relayData);
  }

  // V3RelayData does not include destinationChainId, so it must be supplied separately for v3 types.
  assert(isDefined(destinationChainId));
  return getV3RelayHash(relayData, destinationChainId);
}

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill amount.
 * @note Only compatible with Across v2 data types.
 * @param relayData V2RelayData information that is used to complete a fill.
 * @returns The corresponding RelayData hash.
 */
function getV2RelayHash(relayData: V2RelayData): string {
  return ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [
        "tuple(" +
          "address depositor," +
          "address recipient," +
          "address destinationToken," +
          "uint256 amount," +
          "uint256 originChainId," +
          "uint256 destinationChainId," +
          "int64 realizedLpFeePct," +
          "int64 relayerFeePct," +
          "uint32 depositId," +
          "bytes message" +
          ")",
      ],
      [relayData]
    )
  );
}

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @note Only compatible with Across v3 data types.
 * @param relayData V3RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
function getV3RelayHash(relayData: V3RelayData, destinationChainId: number): string {
  return ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [
        "tuple(" +
          "address depositor," +
          "address recipient," +
          "address exclusiveRelayer," +
          "address inputToken," +
          "address outputToken," +
          "uint256 inputAmount," +
          "uint256 outputAmount," +
          "uint256 originChainId," +
          "uint32 depositId," +
          "uint32 fillDeadline," +
          "uint32 exclusivityDeadline," +
          "bytes message" +
          ")",
        "uint256 destinationChainId",
      ],
      [relayData, destinationChainId]
    )
  );
}
