import { Rpc, SolanaRpcApi, Address } from "@solana/kit";
import { getDeployedBlockNumber } from "@across-protocol/contracts";
import { fetchState } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";

import { Deposit, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { isUnsafeDepositId, BigNumber } from "../../utils";
import { getFillStatusPda } from "./utils";
import { SvmSpokeEventsClient } from "./eventsClient";
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
 * Retrieves the chain time at a particular block.
 * @note This should be the same as getTimeAt() but can differ in test. These two functions should be consolidated.
 * @returns The chain time at the specified block tag.
 */
export async function getTimestampForBlock(provider: Provider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(BigInt(blockNumber)).send();
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
 * @param programId SpokePool program address.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @param destinationChainId Destination chain ID.
 * @param provider Solana RPC provider instance.
 * @param svmEventsClient SvmSpokeEventsClient instance.
 * @returns The fill status for the specified deposit at the requested block (or latest).
 */
export async function relayFillStatus(
  programId: Address,
  relayData: RelayData,
  blockTag: number | "latest",
  destinationChainId: number,
  provider: Provider,
  svmEventsClient: SvmSpokeEventsClient
): Promise<FillStatus> {
  // Get fill status PDA using relayData
  const fillStatusPda = await getFillStatusPda(programId, relayData, destinationChainId);

  // Get fill and requested slow fill events from fillStatusPda
  // TODO: modify this to use svmEventsClient once we can instantiate it with dynamic addresses.
  const fillPdaSignatures = await provider
    .getSignaturesForAddress(fillStatusPda, {
      limit: 1000,
      commitment: "confirmed",
    })
    .send();

  const eventsWithSlots = await Promise.all(
    fillPdaSignatures.map(async (signatureTransaction) => {
      const events = await svmEventsClient.readEventsFromSignature(signatureTransaction.signature);
      return events.map((event) => ({
        ...event,
        confirmationStatus: signatureTransaction.confirmationStatus,
        blockTime: signatureTransaction.blockTime,
        signature: signatureTransaction.signature,
        slot: signatureTransaction.slot,
      }));
    })
  );

  // Translate blockTag from block to slot to use for filtering events
  // This should also be temporary, it can be removed once we can use svmEventsClient with dynamic addresses.
  let toSlot: bigint | undefined;
  if (blockTag === "latest") {
    toSlot = await provider.getSlot().send();
  } else {
    const lowSlot = getDeployedBlockNumber("SvmSpoke", destinationChainId);
    toSlot = await getSlotForBlock(provider, BigInt(blockTag), BigInt(lowSlot));
    if (!toSlot) {
      throw new Error(`Unable to resolve slot for block ${blockTag}`);
    }
  }

  // Filter events by slot and event name
  const relevantEvents = eventsWithSlots
    .flat()
    .filter(
      (event) =>
        event.slot <= toSlot! &&
        [SVMEventNames.FilledRelay, SVMEventNames.RequestedSlowFill].includes(event.name as SVMEventNames)
    );

  if (relevantEvents.length === 0) {
    // No fill or requested slow fill events found for this fill status PDA
    return FillStatus.Unfilled;
  }

  // Sort events in ascending order of slot number
  relevantEvents.sort((a, b) => Number(a.slot - b.slot));

  // At this point we have only fill and requested slow fill events and since it's not possible to submit
  // a slow fill request once a fill has been submitted, we can use the last event in the sorted list to
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
