import { Deposit, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { BigNumber, isUnsafeDepositId } from "../../utils";
import { Provider } from "./types";

/**
 * @param spokePool SpokePool Contract instance.
 * @param deposit V3Deopsit instance.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function populateV3Relay(
  _spokePool: unknown,
  _deposit: Omit<Deposit, "messageHash">,
  _relayer: string,
  _repaymentChainId = _deposit.destinationChainId
): Promise<unknown> {
  throw new Error("populateV3Relay: not implemented");
}

/**
 * Retrieves the time from the SpokePool contract at a particular block.
 * @returns The time at the specified block tag.
 */
export function getTimeAt(_spokePool: unknown, _blockNumber: number): Promise<number> {
  throw new Error("getTimeAt: not implemented");
}

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * Retrieves the chain time at a particular block.
 * @note This should be the same as getTimeAt() but can differ in test. These two functions should be consolidated.
 * @returns The chain time at the specified block tag.
 */
export async function getTimestampForBlock(provider: Provider, blockNumber: number): Promise<number> {
  let slot = await getSlotForBlock(provider, BigInt(blockNumber), BigInt(0));
  if (!slot) {
    console.error(`xxx could not resolve slot for block ${blockNumber}`);
    slot = BigInt(0);
  }

  const block = await provider.getBlock(
    slot,
    { transactionDetails: "none", maxSupportedTransactionVersion: 0 }
  ).send();
  console.log(`xxx got block: ${JSON.stringify(block)}.`);
  let timestamp: number;
  if (!block?.blockTime) {
    console.error(`Unable to resolve svm block ${blockNumber}`);
    timestamp = 0; // @todo: How to handle this?
  } else {
    timestamp = Number(block.blockTime); // Unix timestamps fit within number.
  }

  return timestamp;
}

/**
 * xxx todo
 */
export async function getSlotForBlock(provider: Provider, blockNumber: bigint, lowSlot: bigint, _highSlot?: bigint): Promise<bigint | undefined> {
  // @todo: Factor getBlock out to SlotFinder ??
  const getBlock = async (slot: bigint): Promise<bigint> => {
		const block = await provider.getBlock(
      slot,
	    { transactionDetails: "none", maxSupportedTransactionVersion: 0 }
    ).send();
    return block?.blockHeight ?? BigInt(0);
	}

  let highSlot = _highSlot ?? await provider.getSlot().send();
  const [blockLow, blockHigh] = await Promise.all([
    getBlock(lowSlot),
    getBlock(highSlot),
  ]);

  if (blockLow > blockNumber || blockHigh < blockNumber) {
    return undefined; // blockNumber did not occur within the specified block range.
  }

  // Find the lowest slot number where blockHeight is greater than the requested blockNumber.
  console.log(`Looking for slot for block ${blockNumber} between slots ${lowSlot}, ${highSlot}.`);
  do {
    const midSlot = (highSlot + lowSlot) / BigInt(2);
    const midBlock = await getBlock(midSlot);
    console.log(`xxx got midBlock ${midBlock} for slot ${midSlot}.`);

    if (midBlock < blockNumber) {
      lowSlot = midSlot + BigInt(1);
    } else if (midBlock > blockNumber) {
      highSlot = midSlot + BigInt(1); // blockNumber occurred at or earlier than midBlock.
    } else {
      return midSlot;
    }
  } while (lowSlot <= highSlot);

  return undefined;
}

/**
 * Return maximum of fill deadline buffer at start and end of block range.
 * @param spokePool SpokePool contract instance
 * @param startBlock start block
 * @param endBlock end block
 * @returns maximum of fill deadline buffer at start and end block
 */
export function getMaxFillDeadlineInRange(
  _spokePool: unknown,
  _startBlock: number,
  _endBlock: number
): Promise<number> {
  throw new Error("getMaxFillDeadlineInRange: not implemented");
}

/**
 * Finds the deposit id at a specific block number.
 * @param blockTag The block number to search for the deposit ID at.
 * @returns The deposit ID.
 */
export function getDepositIdAtBlock(_contract: unknown, _blockTag: number): Promise<BigNumber> {
  throw new Error("getDepositIdAtBlock: not implemented");
}

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @param relayData RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
export function getRelayDataHash(_relayData: RelayData, _destinationChainId: number): string {
  throw new Error("getRelayDataHash: not implemented");
}

export function getRelayHashFromEvent(e: RelayData & { destinationChainId: number }): string {
  return getRelayDataHash(e, e.destinationChainId);
}

export function findDepositBlock(
  _spokePool: unknown,
  depositId: BigNumber,
  _lowBlock: number,
  _highBlock?: number
): Promise<number | undefined> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot binary search for depositId ${depositId}`);
  }
  throw new Error("findDepositBlock: not implemented");
}

/**
 * Find the amount filled for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @returns The amount filled for the specified deposit at the requested block (or latest).
 */
export function relayFillStatus(
  _spokePool: unknown,
  _relayData: RelayData,
  _blockTag?: number | "latest",
  _destinationChainId?: number
): Promise<FillStatus> {
  throw new Error("relayFillStatus: not implemented");
}

export function fillStatusArray(
  _spokePool: unknown,
  _relayData: RelayData[],
  _blockTag = "processed"
): Promise<(FillStatus | undefined)[]> {
  throw new Error("fillStatusArray: not implemented");
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
export function findFillBlock(
  _spokePool: unknown,
  _relayData: RelayData,
  _lowBlockNumber: number,
  _highBlockNumber?: number
): Promise<number | undefined> {
  throw new Error("fillStatusArray: not implemented");
}

export function findFillEvent(
  _spokePool: unknown,
  _relayData: RelayData,
  _lowBlockNumber: number,
  _highBlockNumber?: number
): Promise<FillWithBlock | undefined> {
  throw new Error("fillStatusArray: not implemented");
}
