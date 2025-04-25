import assert from "assert";
import { Rpc, SolanaRpcApi, Address } from "@solana/kit";
import { fetchState } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";

import { SvmCpiEventsClient } from "./eventsClient";
import { Deposit, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { BigNumber, chainIsSvm, chunk, isUnsafeDepositId } from "../../utils";
import { getFillStatusPda } from "./utils";
import { SVMEventNames } from "./types";

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
 * Find the fill status for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param fromSlot Slot to start the search at.
 * @param blockTag Slot (numeric or "confirmed") to query at.
 * @returns The fill status for the specified deposit at the requested slot (or at the current confirmed slot).
 */
export async function relayFillStatus(
  programId: Address,
  relayData: RelayData,
  destinationChainId: number,
  provider: Provider,
  svmEventsClient: SvmCpiEventsClient,
  blockTag?: number
): Promise<FillStatus> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");

  // Get fill status PDA using relayData
  const fillStatusPda = await getFillStatusPda(programId, relayData, destinationChainId);

  // Set search range
  let toSlot: bigint;
  if (!blockTag) {
    toSlot = await provider.getSlot({ commitment: "confirmed" }).send();
  } else {
    toSlot = BigInt(blockTag);
  }

  // Get fill and requested slow fill events from fillStatusPda
  const eventsToQuery = [SVMEventNames.FilledRelay, SVMEventNames.RequestedSlowFill];
  const relevantEvents = (
    await Promise.all(
      eventsToQuery.map((eventName) =>
        svmEventsClient.queryDerivedAddressEvents(eventName, fillStatusPda, undefined, toSlot, { limit: 50 })
      )
    )
  ).flat();

  if (relevantEvents.length === 0) {
    // No fill or requested slow fill events found for this fill status PDA
    return FillStatus.Unfilled;
  }

  // Sort events in ascending order of slot number
  relevantEvents.sort((a, b) => Number(a.slot - b.slot));

  // At this point we have an ordered array of fill and requested slow fill events and since it's not possible to
  // submit a slow fill request once a fill has been submitted, we can use the last event in the sorted list to
  // determine the fill status at the requested block.
  const fillStatusEvent = relevantEvents.pop();
  switch (fillStatusEvent!.name) {
    case SVMEventNames.FilledRelay:
      return FillStatus.Filled;
    case SVMEventNames.RequestedSlowFill:
      return FillStatus.RequestedSlowFill;
    default:
      throw new Error(`Unexpected event name: ${fillStatusEvent!.name}`);
  }
}

export async function fillStatusArray(
  programId: Address,
  relayData: RelayData[],
  destinationChainId: number,
  provider: Provider,
  svmEventsClient: SvmCpiEventsClient,
  blockTag?: number
): Promise<(FillStatus | undefined)[]> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");
  const chunkSize = 2;
  const chunkedRelayData = chunk(relayData, chunkSize);
  const results = [];
  for (const chunk of chunkedRelayData) {
    const chunkResults = await Promise.all(
      chunk.map((relayData) =>
        relayFillStatus(programId, relayData, destinationChainId, provider, svmEventsClient, blockTag)
      )
    );
    results.push(...chunkResults);
  }
  return results.flat();
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
