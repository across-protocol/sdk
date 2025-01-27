import assert from "assert";
import { BytesLike, Contract, PopulatedTransaction, providers, utils as ethersUtils } from "ethers";
import { CHAIN_IDs, MAX_SAFE_DEPOSIT_ID, ZERO_ADDRESS, ZERO_BYTES } from "../constants";
import { Deposit, Fill, FillStatus, FillWithBlock, RelayData, SlowFillRequest } from "../interfaces";
import { SpokePoolClient } from "../clients";
import { chunk } from "./ArrayUtils";
import { BigNumber, toBN, bnOne, bnZero } from "./BigNumberUtils";
import { isDefined } from "./TypeGuards";
import { getNetworkName } from "./NetworkUtils";
import { paginatedEventQuery, spreadEventWithBlockNumber } from "./EventUtils";

type BlockTag = providers.BlockTag;

/**
 * @param spokePool SpokePool Contract instance.
 * @param deposit V3Deopsit instance.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function populateV3Relay(
  spokePool: Contract,
  deposit: Deposit,
  relayer: string,
  repaymentChainId = deposit.destinationChainId
): Promise<PopulatedTransaction> {
  const v3RelayData: RelayData = {
    depositor: deposit.depositor,
    recipient: deposit.recipient,
    exclusiveRelayer: deposit.exclusiveRelayer,
    inputToken: deposit.inputToken,
    outputToken: deposit.outputToken,
    inputAmount: deposit.inputAmount,
    outputAmount: deposit.outputAmount,
    originChainId: deposit.originChainId,
    depositId: deposit.depositId,
    fillDeadline: deposit.fillDeadline,
    exclusivityDeadline: deposit.exclusivityDeadline,
    message: deposit.message,
  };
  if (isDefined(deposit.speedUpSignature)) {
    assert(isDefined(deposit.updatedRecipient) && deposit.updatedRecipient !== ZERO_ADDRESS);
    assert(isDefined(deposit.updatedOutputAmount));
    assert(isDefined(deposit.updatedMessage));
    return spokePool.populateTransaction.fillV3RelayWithUpdatedDeposit(
      v3RelayData,
      repaymentChainId,
      deposit.updatedOutputAmount,
      deposit.updatedRecipient,
      deposit.updatedMessage,
      deposit.speedUpSignature,
      { from: relayer }
    );
  }

  return spokePool.populateTransaction.fillV3Relay(v3RelayData, repaymentChainId, { from: relayer });
}

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
 *        // This way the caller can search for a V3FundsDeposited event between [low, high] that will always
 *        // contain the event emitted when deposit ID was incremented to targetDepositId + 1. This is the same transaction
 *        // where the deposit with deposit ID = targetDepositId was created.
 */
export async function getBlockRangeForDepositId(
  targetDepositId: BigNumber,
  initLow: number,
  initHigh: number,
  maxSearches: number,
  spokePool: SpokePoolClient
): Promise<{
  low: number;
  high: number;
}> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(targetDepositId))
    throw new Error(
      `Target deposit ID ${targetDepositId} is deterministic and therefore unresolvable via a binary search.`
    );

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
  const queriedIds: Record<number, BigNumber> = {};

  // Define a llambda function to get the deposit ID at a block number. This function will first check the
  // queriedIds cache to see if the deposit ID at the block number has already been queried. If not, it will
  // make an eth_call request to get the deposit ID at the block number. It will then cache the deposit ID
  // in the queriedIds cache.
  const _getDepositIdAtBlock = async (blockNumber: number): Promise<BigNumber> => {
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
  if (highestDepositIdInRange.lte(targetDepositId)) {
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
  if (lowestDepositIdInRange.gt(targetDepositId)) {
    // initLow   = 5: Deposits Num: 10
    // initLow-1 = 4: Deposits Num:  2
    //                                     // targetId = 1 <- fail (triggers this error)
    //                                     // targetId = 2 <- pass (does not trigger this error)
    //                                     // targetId = 3 <- pass (does not trigger this error)
    throw new Error(
      `Target depositId is less than the initial low block (${targetDepositId.toString()} > ${lowestDepositIdInRange})`
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
    const accountedIdByMidBlock = midDepositId.sub(bnOne);

    // If our target deposit ID is less than the smallest range of our
    // midpoint deposit ID range, then we know that the target deposit ID
    // must be in the lower half of the block range.
    if (targetDepositId.lte(accountedIdByMidBlock)) {
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
export async function getDepositIdAtBlock(contract: Contract, blockTag: number): Promise<BigNumber> {
  const _depositIdAtBlock = await contract.numberOfDeposits({ blockTag });
  const depositIdAtBlock = toBN(_depositIdAtBlock);
  // Sanity check to ensure that the deposit ID is an integer and is greater than or equal to zero.
  if (depositIdAtBlock.lt(bnZero)) {
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
export function getRelayDataHash(relayData: RelayData, destinationChainId: number): string {
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

export function getRelayHashFromEvent(e: Deposit | Fill | SlowFillRequest): string {
  return getRelayDataHash(e, e.destinationChainId);
}

export function isUnsafeDepositId(depositId: BigNumber): boolean {
  // SpokePool.unsafeDepositV3() produces a uint256 depositId by hashing the msg.sender, depositor and input
  // uint256 depositNonce. There is a possibility that this resultant uint256 is less than the maxSafeDepositId (i.e.
  // the maximum uint32 value) which makes it possible that an unsafeDepositV3's depositId can collide with a safe
  // depositV3's depositId, but the chances of a collision are 1 in 2^(256 - 32), so we'll ignore this
  // possibility.
  const maxSafeDepositId = BigNumber.from(MAX_SAFE_DEPOSIT_ID);
  return maxSafeDepositId.lt(depositId);
}

/**
 * Find the amount filled for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @returns The amount filled for the specified deposit at the requested block (or latest).
 */
export async function relayFillStatus(
  spokePool: Contract,
  relayData: RelayData,
  blockTag?: number | "latest",
  destinationChainId?: number
): Promise<FillStatus> {
  destinationChainId ??= await spokePool.chainId();
  const hash = getRelayDataHash(relayData, destinationChainId!);
  const _fillStatus = await spokePool.fillStatuses(hash, { blockTag });
  const fillStatus = Number(_fillStatus);

  if (![FillStatus.Unfilled, FillStatus.RequestedSlowFill, FillStatus.Filled].includes(fillStatus)) {
    const { originChainId, depositId } = relayData;
    throw new Error(
      `relayFillStatus: Unexpected fillStatus for ${originChainId} deposit ${depositId.toString()} (${fillStatus})`
    );
  }

  return fillStatus;
}

export async function fillStatusArray(
  spokePool: Contract,
  relayData: RelayData[],
  blockTag: BlockTag = "latest"
): Promise<(FillStatus | undefined)[]> {
  const fillStatuses = "fillStatuses";
  const destinationChainId = await spokePool.chainId();

  const queries = relayData.map((relayData) => {
    const hash = getRelayDataHash(relayData, destinationChainId);
    return spokePool.interface.encodeFunctionData(fillStatuses, [hash]);
  });

  // Chunk the hashes into appropriate sizes to avoid death by rpc.
  const chunkSize = 250;
  const chunkedQueries = chunk(queries, chunkSize);

  const multicalls = await Promise.all(
    chunkedQueries.map((queries) => spokePool.callStatic.multicall(queries, { blockTag }))
  );
  const status = multicalls
    .map((multicall: BytesLike[]) =>
      multicall.map((result) => spokePool.interface.decodeFunctionResult(fillStatuses, result)[0])
    )
    .flat();

  const bnUnfilled = toBN(FillStatus.Unfilled);
  const bnFilled = toBN(FillStatus.Filled);

  return status.map((status: unknown) => {
    return BigNumber.isBigNumber(status) && status.gte(bnUnfilled) && status.lte(bnFilled)
      ? status.toNumber()
      : undefined;
  });
}

/**
 * Find the block at which a fill was completed.
 * @todo After SpokePool upgrade, this function can be simplified to use the FillStatus enum.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param lowBlockNumber The lower bound of the search. Must be bounded by SpokePool deployment.
 * @param highBlocknumber Optional upper bound for the search.
 * @returns The block number at which the relay was completed, or undefined.
 */
export async function findFillBlock(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<number | undefined> {
  const { provider } = spokePool;
  highBlockNumber ??= await provider.getBlockNumber();
  assert(highBlockNumber > lowBlockNumber, `Block numbers out of range (${lowBlockNumber} >= ${highBlockNumber})`);

  // In production the chainId returned from the provider matches 1:1 with the actual chainId. Querying the provider
  // object saves an RPC query becasue the chainId is cached by StaticJsonRpcProvider instances. In hre, the SpokePool
  // may be configured with a different chainId than what is returned by the provider.
  // @todo Sub out actual chain IDs w/ CHAIN_IDs constants
  const destinationChainId = Object.values(CHAIN_IDs).includes(relayData.originChainId)
    ? (await provider.getNetwork()).chainId
    : Number(await spokePool.chainId());
  assert(
    relayData.originChainId !== destinationChainId,
    `Origin & destination chain IDs must not be equal (${destinationChainId})`
  );

  // Make sure the relay war completed within the block range supplied by the caller.
  const [initialFillStatus, finalFillStatus] = (
    await Promise.all([
      relayFillStatus(spokePool, relayData, lowBlockNumber, destinationChainId),
      relayFillStatus(spokePool, relayData, highBlockNumber, destinationChainId),
    ])
  ).map(Number);

  if (finalFillStatus !== FillStatus.Filled) {
    return undefined; // Wasn't filled within the specified block range.
  }

  // Was filled earlier than the specified lowBlock. This is an error by the caller.
  if (initialFillStatus === FillStatus.Filled) {
    const { depositId, originChainId } = relayData;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
    throw new Error(`${srcChain} deposit ${depositId.toString()} filled on ${dstChain} before block ${lowBlockNumber}`);
  }

  // Find the leftmost block where filledAmount equals the deposit amount.
  do {
    const midBlockNumber = Math.floor((highBlockNumber + lowBlockNumber) / 2);
    const fillStatus = await relayFillStatus(spokePool, relayData, midBlockNumber, destinationChainId);

    if (fillStatus === FillStatus.Filled) {
      highBlockNumber = midBlockNumber;
    } else {
      lowBlockNumber = midBlockNumber + 1;
    }
  } while (lowBlockNumber < highBlockNumber);

  return lowBlockNumber;
}

export async function findFillEvent(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<FillWithBlock | undefined> {
  const blockNumber = await findFillBlock(spokePool, relayData, lowBlockNumber, highBlockNumber);
  if (!blockNumber) return undefined;
  const query = await paginatedEventQuery(
    spokePool,
    spokePool.filters.FilledV3Relay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
    {
      fromBlock: blockNumber,
      toBlock: blockNumber,
      maxBlockLookBack: 0, // We can hardcode this to 0 to instruct paginatedEventQuery to make a single request
      // for the same block number.
    }
  );
  if (query.length === 0) throw new Error(`Failed to find fill event at block ${blockNumber}`);
  const event = query[0];
  // In production the chainId returned from the provider matches 1:1 with the actual chainId. Querying the provider
  // object saves an RPC query becasue the chainId is cached by StaticJsonRpcProvider instances. In hre, the SpokePool
  // may be configured with a different chainId than what is returned by the provider.
  // @todo Sub out actual chain IDs w/ CHAIN_IDs constants
  const destinationChainId = Object.values(CHAIN_IDs).includes(relayData.originChainId)
    ? (await spokePool.provider.getNetwork()).chainId
    : Number(await spokePool.chainId());
  const fill = {
    ...spreadEventWithBlockNumber(event),
    destinationChainId,
  } as FillWithBlock;
  return fill;
}

// Determines if the input address (either a bytes32 or bytes20) is the zero address.
export function isZeroAddress(address: string): boolean {
  return address === ZERO_ADDRESS || address === ZERO_BYTES;
}
