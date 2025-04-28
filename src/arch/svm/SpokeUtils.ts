import assert from "assert";
import { Rpc, SolanaRpcApi, Address, fetchEncodedAccounts, fetchEncodedAccount } from "@solana/kit";
import { fetchState, decodeFillStatusAccount } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";

import { SvmCpiEventsClient } from "./eventsClient";
import { Deposit, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { BigNumber, chainIsSvm, chunk, getCurrentTime, isUnsafeDepositId } from "../../utils";
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
 * Resolves the fill status of a deposit at a specific slot or at the current confirmed one.
 *
 * If no slot is provided, the function first tries to fetch the status from the fill status PDA.
 * - If the PDA exists, it reads the status directly.
 * - If the PDA is missing and the deposit's fill deadline has not passed, the deposit is considered unfilled.
 *
 * If a specific slot is requested, or if the PDA is unavailable, the status is reconstructed from PDA events.
 *
 * @param programId - The spoke pool program ID.
 * @param relayData - Deposit information used to locate the fill status.
 * @param destinationChainId - Destination chain ID (must be an SVM chain).
 * @param provider - SVM provider instance.
 * @param svmEventsClient - SVM events client for querying events.
 * @param atHeight - (Optional) Specific slot number to query. Defaults to the latest confirmed slot.
 * @returns The fill status for the deposit at the specified or current slot.
 */
export async function relayFillStatus(
  programId: Address,
  relayData: RelayData,
  destinationChainId: number,
  provider: Provider,
  svmEventsClient: SvmCpiEventsClient,
  atHeight?: number
): Promise<FillStatus> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");

  // Get fill status PDA using relayData
  const fillStatusPda = await getFillStatusPda(programId, relayData, destinationChainId);

  // If no specific slot is requested, try fetching the current status from the PDA
  if (atHeight === undefined) {
    const fillStatusAccount = await fetchEncodedAccount(provider, fillStatusPda, { commitment: "confirmed" });

    // If the PDA exists, return the stored fill status
    if (fillStatusAccount.exists) {
      const decodedAccountData = decodeFillStatusAccount(fillStatusAccount);
      return decodedAccountData.data.status;
    }
    // If the PDA doesn't exist and the deadline hasn't passed yet, the deposit must be unfilled,
    // since PDAs can't be closed before the fill deadline.
    else if (getCurrentTime() < relayData.fillDeadline) {
      return FillStatus.Unfilled;
    }
  }

  // If status couldn't be determined from the PDA, or if a specific slot was requested, reconstruct the status from events
  const toSlot = atHeight ? BigInt(atHeight) : await provider.getSlot({ commitment: "confirmed" }).send();

  return resolveFillStatusFromPdaEvents(fillStatusPda, toSlot, svmEventsClient);
}

/**
 * Resolves the fill status of an array of deposits at the requested slot or at the current confirmed one.
 * For current slot queries, first tries to fetch statuses using the PDAs.
 * When PDAs are unavailable, or for specific slot queries, it reconstructs status using PDA events.
 *
 * @param programId The spoke pool program ID.
 * @param relayData An array of relay data to resolve fill statuses for.
 * @param destinationChainId The destination chain ID (must be an SVM chain).
 * @param provider SVM Provider instance.
 * @param svmEventsClient SVM events client instance for querying events.
 * @param atHeight (Optional) The slot number to query at. If omitted, queries the latest confirmed slot.
 * @returns An array of fill statuses for the specified deposits at the requested slot (or at the current confirmed slot).
 */
export async function fillStatusArray(
  programId: Address,
  relayData: RelayData[],
  destinationChainId: number,
  provider: Provider,
  svmEventsClient: SvmCpiEventsClient,
  atHeight?: number
): Promise<(FillStatus | undefined)[]> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");

  const chunkSize = 100;
  const chunkedRelayData = chunk(relayData, chunkSize);

  // Get all PDAs
  const fillStatusPdas = (
    await Promise.all(
      chunkedRelayData.map((relayDataChunk) =>
        Promise.all(relayDataChunk.map((relayData) => getFillStatusPda(programId, relayData, destinationChainId)))
      )
    )
  ).flat();

  // If no specific slot is requested, try fetching current statuses from PDAs
  // Otherwise, initialize all statuses as undefined
  const fillStatuses: (FillStatus | undefined)[] =
    atHeight === undefined
      ? await fetchBatchFillStatusFromPdaAccounts(provider, fillStatusPdas, relayData)
      : new Array(relayData.length).fill(undefined);

  // Collect indices of deposits that still need their status resolved
  const missingStatuses = fillStatuses.reduce<number[]>((acc, status, index) => {
    if (status === undefined) {
      acc.push(index);
    }
    return acc;
  }, []);

  // Chunk the missing deposits for batch processing
  const missingChunked = chunk(missingStatuses, chunkSize);
  const missingResults: { index: number; fillStatus: FillStatus }[] = [];

  // Determine the toSlot to use for event reconstruction
  const toSlot = atHeight ? BigInt(atHeight) : await provider.getSlot({ commitment: "confirmed" }).send();

  // @note: This path is mostly used for deposits past their fill deadline.
  // If it becomes a bottleneck, consider returning an "Unknown" status that can be handled downstream.
  for (const chunk of missingChunked) {
    const start = performance.now();
    const chunkResults = await Promise.all(
      chunk.map(async (missingIndex) => {
        return {
          index: missingIndex,
          fillStatus: await resolveFillStatusFromPdaEvents(fillStatusPdas[missingIndex], toSlot, svmEventsClient),
        };
      })
    );
    missingResults.push(...chunkResults);
    const end = performance.now();
    console.log(`Processing ${chunk.length} deposits took ${end - start}ms`);
  }

  // Fill in missing statuses back to the result array
  missingResults.forEach(({ index, fillStatus }) => {
    fillStatuses[index] = fillStatus;
  });

  return fillStatuses;
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

async function resolveFillStatusFromPdaEvents(
  fillStatusPda: Address,
  toSlot: bigint,
  svmEventsClient: SvmCpiEventsClient
): Promise<FillStatus> {
  // Get fill and requested slow fill events from fillStatus PDA
  const eventsToQuery = [SVMEventNames.FilledRelay, SVMEventNames.RequestedSlowFill];
  const relevantEvents = (
    await Promise.all(
      eventsToQuery.map((eventName) =>
        // PDAs should have only a few events, requesting up to 10 should be enough.
        svmEventsClient.queryDerivedAddressEvents(eventName, fillStatusPda, undefined, toSlot, { limit: 10 })
      )
    )
  ).flat();

  if (relevantEvents.length === 0) {
    // No fill or requested slow fill events found for this PDA
    return FillStatus.Unfilled;
  }

  // Sort events in ascending order of slot number
  relevantEvents.sort((a, b) => Number(a.slot - b.slot));

  // At this point we have an ordered array of only fill and requested slow fill events and
  // since it's not possible to submit a slow fill request once a fill has been submitted,
  // we can use the last event in the list to determine the fill status at the requested slot.
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

/**
 * Attempts to resolve the fill status for an array of deposits by reading their fillStatus PDAs.
 *
 * - If a PDA exists, the status is read directly from it.
 * - If the PDA does not exist but the deposit's fill deadline has not passed, the deposit is considered unfilled.
 * - If the PDA does not exist and the fill deadline has passed, the status cannot be determined and is set to undefined.
 *
 * Assumes PDAs can only be closed after the fill deadline expires.
 *
 * @param provider SVM provider instance
 * @param fillStatusPdas An array of fill status PDAs to retrieve the fill status for.
 * @param relayData An array of relay data from which the fill status PDAs were derived.
 */
async function fetchBatchFillStatusFromPdaAccounts(
  provider: Provider,
  fillStatusPdas: Address[],
  relayDataArray: RelayData[]
): Promise<(FillStatus | undefined)[]> {
  const chunkSize = 100; // SVM method getMultipleAccounts allows a max of 100 addresses per request
  const pdaAccounts = (
    await Promise.all(
      chunk(fillStatusPdas, chunkSize).map((chunk) =>
        fetchEncodedAccounts(provider, chunk, { commitment: "confirmed" })
      )
    )
  ).flat();

  const fillStatuses = pdaAccounts.map((account, index) => {
    // If the PDA exists, we can fetch the status directly.
    if (account.exists) {
      const decodedAccount = decodeFillStatusAccount(account);
      return decodedAccount.data.status;
    }
    // If the PDA doesn't exist and the deadline hasn't passed yet, the deposit must be unfilled,
    // since PDAs can't be closed before the fill deadline.
    else if (getCurrentTime() < relayDataArray[index].fillDeadline) {
      return FillStatus.Unfilled;
    }
    // If the PDA doesn't exist and the fill deadline has passed, then the status can't be determined and is set to undefined.
    return undefined;
  });

  return fillStatuses;
}
