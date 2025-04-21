import { Rpc, SolanaRpcApi, Address } from "@solana/kit";

import { Deposit, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { BigNumber, isUnsafeDepositId } from "../../utils";
import { fetchState } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";
import { SvmCpiEventsClient } from "./eventsClient";

type Provider = Rpc<SolanaRpcApi>;

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

/**
 * Retrieves the chain time at a particular slot.
 * @note This should be the same as getTimeAt() but can differ in test. These two functions should be consolidated.
 * @returns The chain time at the specified slot.
 */
export async function getTimestampForSlot(provider: Provider, slotNumber: number): Promise<number> {
  const block = await provider.getBlock(BigInt(slotNumber)).send();
  let timestamp: number;
  if (!block?.blockTime) {
    console.error(`Unable to resolve block for slot ${slotNumber}`);
    timestamp = 0; // @todo: How to handle this?
  } else {
    timestamp = Number(block.blockTime); // Unix timestamps fit within number.
  }

  return timestamp;
}

/**
 * Returns the current fill deadline buffer.
 * @param provider SVM Provider instance
 * @param statePda Spoke Pool's State PDA
 * @returns fill deadline buffer
 */
export async function getFillDeadline(provider: Provider, statePda: Address): Promise<number> {
  const state = await fetchState(provider, statePda);
  return state.data.fillDeadlineBuffer;
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
 * xxx todo
 */
export async function getSlotForBlock(
  provider: Provider,
  blockNumber: bigint,
  lowSlot: bigint,
  _highSlot?: bigint
): Promise<bigint | undefined> {
  // @todo: Factor getBlock out to SlotFinder ??
  const getBlockNumber = async (slot: bigint): Promise<bigint> => {
    const block = await provider
      .getBlock(slot, { transactionDetails: "none", maxSupportedTransactionVersion: 0 })
      .send();
    return block?.blockHeight ?? BigInt(0); // @xxx Handle undefined here!
  };

  let highSlot = _highSlot ?? (await provider.getSlot().send());
  const [blockLow = 0, blockHigh = 1_000_000_000] = await Promise.all([
    getBlockNumber(lowSlot),
    getBlockNumber(highSlot),
  ]);

  if (blockLow > blockNumber || blockHigh < blockNumber) {
    return undefined; // blockNumber did not occur within the specified block range.
  }

  // Find the lowest slot number where blockHeight is greater than the requested blockNumber.
  do {
    const midSlot = (highSlot + lowSlot) / BigInt(2);
    const midBlock = await getBlockNumber(midSlot);

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
 * Finds the block number and slot for a given deposit ID by querying for deposit events
 * within a limited time range.
 *
 * @remarks
 * This implementation uses a time-limited search approach because Solana PDA state has
 * limitations that prevent directly referencing old deposit IDs. Unlike EVM chains where
 * we might use binary search across the entire chain history, in Solana we must query within
 * a constrained block range.
 *
 * We use a 2-day lookback window as a heuristic because:
 * 1. Most valid deposits that need to be processed will be recent
 * 2. This covers multiple bundle submission periods
 * 3. It balances performance with practical deposit age
 *
 * @important
 * This function may return `undefined` for valid deposit IDs that are older than the search
 * window (approximately 2 days). This is an acceptable limitation as deposits this old are
 * typically not relevant to current operations.
 *
 * @param provider - Solana RPC provider
 * @param depositId - The deposit ID to search for
 * @returns The block number and slot where the deposit occurred, or undefined if not found
 */
export async function findDepositBlock(
  provider: Provider,
  depositId: BigNumber
): Promise<{ block: BigNumber; slot: BigNumber } | undefined> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot binary search for depositId ${depositId}`);
  }
  // Create an event client to query for the deposit event.
  const eventClient = await SvmCpiEventsClient.create(provider);

  // We know we're likely to not be searching for a deposit id that is
  // greater than 2 days old, so we'll start by finding a block from two
  // days ago. On average, blocks in Solana are produced every 300ms or so
  // so we can use that to calculate a block number.
  const msTwoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const elapsedBlocks = BigInt(msTwoDaysAgo) / BigInt(300);
  const currentBlock = await provider.getBlockHeight({ commitment: "confirmed" }).send();
  const startBlock = currentBlock - elapsedBlocks;
  // Query for the deposit events with this limited block range. Filter by deposit id.
  const depositEvent = (await eventClient.queryEvents("FundsDeposited", startBlock, currentBlock))?.find((event) =>
    depositId.eq((event.data as unknown as { depositId: BigNumber }).depositId)
  );

  if (!depositEvent) {
    return undefined;
  }
  const block = await provider.getBlock(depositEvent.slot).send();
  if (!block) {
    return undefined;
  }

  return { block: BigNumber.from(block.blockHeight), slot: BigNumber.from(depositEvent.slot) };
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
