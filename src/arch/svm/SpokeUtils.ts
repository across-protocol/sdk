import { Rpc, SolanaRpcApi, Address } from "@solana/kit";

import { BigNumber, getCurrentTime, isUnsafeDepositId } from "../../utils";
import { fetchState } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";
import { SvmCpiEventsClient } from "./eventsClient";
import { Deposit, DepositWithBlock, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { unwrapEventData } from ".";

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
 * Finds deposit events within a 2-day window ending at the specified timestamp.
 *
 * @remarks
 * This implementation uses a time-limited search approach because Solana PDA state has
 * limitations that prevent directly referencing old deposit IDs. Unlike EVM chains where
 * we might use binary search across the entire chain history, in Solana we must query within
 * a constrained slot range.
 *
 * The search window is calculated by:
 * 1. Finding the slot at the specified timestamp (or current time if no timestamp is provided)
 * 2. Looking back 2 days worth of slots from that point
 *
 * We use a 2-day window because:
 * 1. Most valid deposits that need to be processed will be recent
 * 2. This covers multiple bundle submission periods
 * 3. It balances performance with practical deposit age
 *
 * @important
 * This function may return `undefined` for valid deposit IDs that are older than the search
 * window (approximately 2 days before the specified timestamp). This is an acceptable limitation
 * as deposits this old are typically not relevant to current operations.
 *
 * @param eventClient - SvmCpiEventsClient instance
 * @param depositId - The deposit ID to search for
 * @param timestamp - The timestamp to search up to (defaults to current time). The search will look
 *                   for deposits between (timestamp - 2 days) and timestamp. Time must be in seconds.
 * @returns The deposit if found within the time window, undefined otherwise
 */
export async function findDeposit(
  eventClient: SvmCpiEventsClient,
  depositId: BigNumber,
  timestamp: number = getCurrentTime()
): Promise<DepositWithBlock | undefined> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot binary search for depositId ${depositId}`);
  }
  const [currentTimeInMs, timestampInMs] = [getCurrentTime() * 1000, timestamp * 1000];
  const slotDurationInMs = 300;

  // We know we're likely to not be searching for a deposit id that is
  // greater than two days older than the provided timestamp (or current time if no timestamp is provided)
  // therefore we can use the current block and timestamp to calculate the slot at the timestamp and then
  // calculate two days ago from that slot.
  const provider = eventClient.getRpc();
  const currentSlot = await provider.getSlot({ commitment: "confirmed" }).send();
  const endSlot = currentSlot - BigInt(Math.round((currentTimeInMs - timestampInMs) / slotDurationInMs));
  const startSlot = endSlot - BigInt(Math.round((2 * 24 * 60 * 60 * 1000) / slotDurationInMs));

  // Query for the deposit events with this limited block range. Filter by deposit id.
  const depositEvent = (await eventClient.queryEvents("FundsDeposited", startSlot, endSlot))?.find((event) =>
    depositId.eq((event.data as unknown as { depositId: BigNumber }).depositId)
  );

  if (!depositEvent) {
    return undefined;
  }

  return {
    transactionHash: depositEvent.signature.toString(),
    blockNumber: Number(depositEvent.slot),
    transactionIndex: 0,
    logIndex: 0,
    ...(unwrapEventData(depositEvent.data) as Record<string, unknown>),
  } as DepositWithBlock;
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
