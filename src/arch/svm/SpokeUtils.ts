import { MessageTransmitterClient, SvmSpokeClient } from "@across-protocol/contracts";
import { decodeFillStatusAccount, fetchState } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";
import { hashNonEmptyMessage } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  fetchMint,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import {
  Address,
  appendTransactionMessageInstruction,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  IAccountMeta,
  pipe,
  some,
  type TransactionSigner,
} from "@solana/kit";
import assert from "assert";
import { arrayify, hexZeroPad, hexlify } from "ethers/lib/utils";
import { Logger } from "winston";

import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { Deposit, DepositWithBlock, FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import {
  BigNumber,
  EvmAddress,
  SvmAddress,
  chainIsSvm,
  chunk,
  isUnsafeDepositId,
  keccak256,
  toAddressType,
} from "../../utils";
import {
  SvmCpiEventsClient,
  createDefaultTransaction,
  getEventAuthority,
  getFillStatusPda,
  getStatePda,
  toAddress,
  unwrapEventData,
} from "./";
import { SVMEventNames, SVMProvider } from "./types";

/**
 * @note: Average Solana slot duration is about 400-500ms. We can be conservative
 *        and choose 400 to ensure that the most slots get included in our ranges
 */
export const SLOT_DURATION_MS = 400;

/**
 * Retrieves the chain time at a particular slot.
 */
export async function getTimestampForSlot(provider: SVMProvider, slotNumber: number): Promise<number> {
  // @note: getBlockTime receives a slot number, not a block number.
  const slotTime = await provider.getBlockTime(BigInt(slotNumber)).send();
  return Number(slotTime);
}

/**
 * Returns the current fill deadline buffer.
 * @param provider SVM Provider instance
 * @param statePda Spoke Pool's State PDA
 * @returns fill deadline buffer
 */
export async function getFillDeadline(provider: SVMProvider, statePda: Address): Promise<number> {
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
 * Finds deposit events within a 2-day window ending at the specified slot.
 *
 * @remarks
 * This implementation uses a slot-limited search approach because Solana PDA state has
 * limitations that prevent directly referencing old deposit IDs. Unlike EVM chains where
 * we might use binary search across the entire chain history, in Solana we must query within
 * a constrained slot range.
 *
 * The search window is calculated by:
 * 1. Using the provided slot (or current confirmed slot if none is provided)
 * 2. Looking back 2 days worth of slots from that point
 *
 * We use a 2-day window because:
 * 1. Most valid deposits that need to be processed will be recent
 * 2. This covers multiple bundle submission periods
 * 3. It balances performance with practical deposit age
 *
 * @important
 * This function may return `undefined` for valid deposit IDs that are older than the search
 * window (approximately 2 days before the specified slot). This is an acceptable limitation
 * as deposits this old are typically not relevant to current operations.
 *
 * @param eventClient - SvmCpiEventsClient instance
 * @param depositId - The deposit ID to search for
 * @param slot - The slot to search up to (defaults to current slot). The search will look
 *              for deposits between (slot - secondsLookback) and slot.
 * @param secondsLookback - The number of seconds to look back for deposits (defaults to 2 days).
 * @returns The deposit if found within the slot window, undefined otherwise
 */
export async function findDeposit(
  eventClient: SvmCpiEventsClient,
  depositId: BigNumber,
  slot?: bigint,
  secondsLookback = 2 * 24 * 60 * 60 // 2 days
): Promise<DepositWithBlock | undefined> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot binary search for depositId ${depositId}`);
  }

  const provider = eventClient.getRpc();
  const currentSlot = await provider.getSlot({ commitment: "confirmed" }).send();

  // If no slot is provided, use the current slot
  // If a slot is provided, ensure it's not in the future
  const endSlot = slot !== undefined ? BigInt(Math.min(Number(slot), Number(currentSlot))) : currentSlot;

  // Calculate start slot (approximately secondsLookback seconds earlier)
  const slotsInElapsed = BigInt(Math.round((secondsLookback * 1000) / SLOT_DURATION_MS));
  const startSlot = endSlot - slotsInElapsed;

  // Query for the deposit events with this limited slot range. Filter by deposit id.
  const depositEvent = (await eventClient.queryEvents("FundsDeposited", startSlot, endSlot))?.find((event) =>
    depositId.eq((event.data as unknown as { depositId: BigNumber }).depositId)
  );

  // If no deposit event is found, return undefined
  if (!depositEvent) {
    return undefined;
  }

  // Return the deposit event with block info
  return {
    txnRef: depositEvent.signature.toString(),
    blockNumber: Number(depositEvent.slot),
    txnIndex: 0,
    logIndex: 0,
    ...(unwrapEventData(depositEvent.data) as Record<string, unknown>),
  } as DepositWithBlock;
}

/**
 * Resolves the fill status of a deposit at a specific slot or at the current confirmed one.
 *
 * If no slot is provided, attempts to solve the fill status using the PDA. Otherwise, it is reconstructed from PDA events.
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
  svmEventsClient: SvmCpiEventsClient,
  atHeight?: number
): Promise<FillStatus> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");
  const provider = svmEventsClient.getRpc();
  // Get fill status PDA using relayData
  const fillStatusPda = await getFillStatusPda(programId, relayData, destinationChainId);
  const currentSlot = await provider.getSlot({ commitment: "confirmed" }).send();

  // If no specific slot is requested, try fetching the current status from the PDA
  if (atHeight === undefined) {
    const [fillStatusAccount, currentSlotTimestamp] = await Promise.all([
      fetchEncodedAccount(provider, fillStatusPda, { commitment: "confirmed" }),
      provider.getBlockTime(currentSlot).send(),
    ]);
    // If the PDA exists, return the stored fill status
    if (fillStatusAccount.exists) {
      const decodedAccountData = decodeFillStatusAccount(fillStatusAccount);
      return decodedAccountData.data.status;
    }
    // If the PDA doesn't exist and the deadline hasn't passed yet, the deposit must be unfilled,
    // since PDAs can't be closed before the fill deadline.
    else if (Number(currentSlotTimestamp) < relayData.fillDeadline) {
      return FillStatus.Unfilled;
    }
  }

  // If status couldn't be determined from the PDA, or if a specific slot was requested, reconstruct the status from events
  const toSlot = atHeight ? BigInt(atHeight) : currentSlot;

  return resolveFillStatusFromPdaEvents(fillStatusPda, toSlot, svmEventsClient);
}

/**
 * Resolves fill statuses for multiple deposits at a specific or latest confirmed slot,
 * using PDAs when possible and falling back to events if needed.
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
  svmEventsClient: SvmCpiEventsClient,
  atHeight?: number,
  logger?: Logger
): Promise<(FillStatus | undefined)[]> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");
  const provider = svmEventsClient.getRpc();
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

  if (atHeight !== undefined && logger) {
    logger.warn({
      at: "SvmSpokeUtils#fillStatusArray",
      message:
        "Querying specific slots for large arrays is slow. For current status, omit 'atHeight' param to use latest confirmed slot instead.",
    });
  }

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
    const chunkResults = await Promise.all(
      chunk.map(async (missingIndex) => {
        return {
          index: missingIndex,
          fillStatus: await resolveFillStatusFromPdaEvents(fillStatusPdas[missingIndex], toSlot, svmEventsClient),
        };
      })
    );
    missingResults.push(...chunkResults);
  }

  // Fill in missing statuses back to the result array
  missingResults.forEach(({ index, fillStatus }) => {
    fillStatuses[index] = fillStatus;
  });

  return fillStatuses;
}

/**
 * Finds the `FilledRelay` event for a given deposit within the provided slot range.
 *
 * @param relayData - Deposit information that is used to complete a fill.
 * @param destinationChainId - Destination chain ID (must be an SVM chain).
 * @param svmEventsClient - SVM events client instance for querying events.
 * @param fromSlot - Starting slot to search.
 * @param toSlot (Optional) Ending slot to search. If not provided, the current confirmed slot will be used.
 * @returns The fill event with block info, or `undefined` if not found.
 */
export async function findFillEvent(
  relayData: RelayData,
  destinationChainId: number,
  svmEventsClient: SvmCpiEventsClient,
  fromSlot: number,
  toSlot?: number
): Promise<FillWithBlock | undefined> {
  assert(chainIsSvm(destinationChainId), "Destination chain must be an SVM chain");
  toSlot ??= Number(await svmEventsClient.getRpc().getSlot({ commitment: "confirmed" }).send());

  // Get fillStatus PDA using relayData
  const programId = svmEventsClient.getProgramAddress();
  const fillStatusPda = await getFillStatusPda(programId, relayData, destinationChainId);

  // Get fill events from fillStatus PDA
  const fillEvents = await svmEventsClient.queryDerivedAddressEvents(
    SVMEventNames.FilledRelay,
    fillStatusPda,
    BigInt(fromSlot),
    BigInt(toSlot),
    { limit: 10 }
  );
  assert(fillEvents.length <= 1, `Expected at most one fill event for ${fillStatusPda}, got ${fillEvents.length}`);

  if (fillEvents.length > 0) {
    const rawFillEvent = fillEvents[0];
    const parsedFillEvent = {
      transactionHash: rawFillEvent.signature,
      blockNumber: Number(rawFillEvent.slot),
      transactionIndex: 0,
      logIndex: 0,
      destinationChainId,
      ...(unwrapEventData(rawFillEvent.data) as Record<string, unknown>),
    } as unknown as FillWithBlock;
    return parsedFillEvent;
  }

  return undefined;
}

/**
 * @param spokePool Address (program ID) of the SvmSpoke.
 * @param deposit V3Deopsit instance.
 * @param relayer Address of the relayer filling the deposit.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export async function fillRelayInstruction(
  spokePool: SvmAddress,
  deposit: Omit<Deposit, "messageHash" | "fromLiteChain" | "toLiteChain">,
  signer: TransactionSigner<string>,
  recipientTokenAccount: Address<string>,
  repaymentAddress: EvmAddress | SvmAddress = SvmAddress.from(signer.address),
  repaymentChainId = deposit.destinationChainId
) {
  const program = toAddress(spokePool);

  assert(
    repaymentAddress.isValidOn(repaymentChainId),
    `Invalid repayment address for chain ${repaymentChainId}: ${repaymentAddress.toNative()}.`
  );

  const _relayDataHash = getRelayDataHash(deposit, deposit.destinationChainId);
  const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

  const relayer = SvmAddress.from(signer.address);
  // Create ATA for the relayer and recipient token accounts
  const relayerTokenAccount = await getAssociatedTokenAddress(
    relayer,
    toAddressType(deposit.outputToken, deposit.destinationChainId)
  );

  const [statePda, fillStatusPda, eventAuthority] = await Promise.all([
    getStatePda(program),
    getFillStatusPda(program, deposit, deposit.destinationChainId),
    getEventAuthority(),
  ]);
  const depositIdBuffer = new Uint8Array(32);
  const shortenedBuffer = new Uint8Array(Buffer.from(deposit.depositId.toHexString().slice(2), "hex"));
  depositIdBuffer.set(shortenedBuffer, 32 - shortenedBuffer.length);

  const delegatePda = await getFillRelayDelegatePda(
    relayDataHash,
    BigInt(repaymentChainId),
    toAddress(relayer),
    program
  );

  // @todo we need to convert the deposit's relayData to svm-like since the interface assumes the data originates
  // from an EVM Spoke pool. Once we migrate to `Address` types, this can be modified/removed.
  const [depositor, inputToken] = [deposit.depositor, deposit.inputToken].map((addr: string) =>
    toAddress(toAddressType(addr, deposit.originChainId))
  );
  const [recipient, outputToken, exclusiveRelayer] = [
    deposit.recipient,
    deposit.outputToken,
    deposit.exclusiveRelayer,
  ].map((addr) => toAddress(toAddressType(addr, deposit.destinationChainId)));

  return SvmSpokeClient.getFillRelayInstruction({
    signer,
    state: statePda,
    delegate: toAddress(SvmAddress.from(delegatePda.toString())),
    mint: outputToken,
    relayerTokenAccount: relayerTokenAccount,
    recipientTokenAccount: recipientTokenAccount,
    fillStatus: fillStatusPda,
    eventAuthority,
    program,
    relayHash: relayDataHash,
    relayData: some({
      depositor,
      recipient,
      exclusiveRelayer,
      inputToken,
      outputToken,
      inputAmount: deposit.inputAmount.toBigInt(),
      outputAmount: deposit.outputAmount.toBigInt(),
      originChainId: BigInt(deposit.originChainId),
      fillDeadline: deposit.fillDeadline,
      exclusivityDeadline: deposit.exclusivityDeadline,
      depositId: depositIdBuffer,
      message: new Uint8Array(Buffer.from(deposit.message.slice(2), "hex")),
    }),
    repaymentChainId: some(BigInt(repaymentChainId)),
    repaymentAddress: toAddress(repaymentAddress),
  });
}

/**
 * @param mint Address of the token corresponding to the account being made.
 * @param relayer Address of the relayer filling the deposit.
 * @returns An instruction for creating a new token account.
 */
export function createTokenAccountsInstruction(
  mint: SvmAddress,
  relayer: TransactionSigner<string>
): SvmSpokeClient.CreateTokenAccountsInstruction {
  return SvmSpokeClient.getCreateTokenAccountsInstruction({
    signer: relayer,
    mint: toAddress(mint),
  });
}

/**
 * Creates a fill instruction.
 * @param signer - The signer of the transaction.
 * @param solanaClient - The Solana client.
 * @param fillInput - The fill input.
 * @param tokenDecimals - The token decimals.
 * @param createRecipientAtaIfNeeded - Whether to create a recipient token account.
 * @returns The fill instruction.
 */
export const createFillInstruction = async (
  signer: TransactionSigner,
  solanaClient: SVMProvider,
  fillInput: SvmSpokeClient.FillRelayInput,
  tokenDecimals: number,
  createRecipientAtaIfNeeded: boolean = true
) => {
  const mintInfo = await fetchMint(solanaClient, fillInput.mint);
  const approveIx = getApproveCheckedInstruction(
    {
      source: fillInput.relayerTokenAccount,
      mint: fillInput.mint,
      delegate: fillInput.delegate,
      owner: fillInput.signer,
      amount: (fillInput.relayData as SvmSpokeClient.RelayDataArgs).outputAmount,
      decimals: tokenDecimals,
    },
    {
      programAddress: mintInfo.programAddress,
    }
  );

  const getCreateAssociatedTokenIdempotentIx = () =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      owner: (fillInput.relayData as SvmSpokeClient.RelayDataArgs).recipient,
      mint: fillInput.mint,
      ata: fillInput.recipientTokenAccount,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      tokenProgram: fillInput.tokenProgram,
    });

  const createFillIx = SvmSpokeClient.getFillRelayInstruction(fillInput);

  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) =>
      createRecipientAtaIfNeeded ? appendTransactionMessageInstruction(getCreateAssociatedTokenIdempotentIx(), tx) : tx,
    (tx) => appendTransactionMessageInstruction(approveIx, tx),
    (tx) => appendTransactionMessageInstruction(createFillIx, tx)
  );
};

/**
 * Creates a deposit instruction.
 * @param signer - The signer of the transaction.
 * @param solanaClient - The Solana client.
 * @param depositInput - The deposit input.
 * @param tokenDecimals - The token decimals.
 * @param createVaultAtaIfNeeded - Whether to create a vault token account.
 * @returns The deposit instruction.
 */
export const createDepositInstruction = async (
  signer: TransactionSigner,
  solanaClient: SVMProvider,
  depositInput: SvmSpokeClient.DepositInput,
  tokenDecimals: number,
  createVaultAtaIfNeeded: boolean = true
) => {
  const getCreateAssociatedTokenIdempotentIx = () =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      owner: depositInput.state,
      mint: depositInput.mint,
      ata: depositInput.vault,
      systemProgram: depositInput.systemProgram,
      tokenProgram: depositInput.tokenProgram,
    });
  const mintInfo = await fetchMint(solanaClient, depositInput.mint);
  const approveIx = getApproveCheckedInstruction(
    {
      source: depositInput.depositorTokenAccount,
      mint: depositInput.mint,
      delegate: depositInput.delegate,
      owner: depositInput.depositor,
      amount: depositInput.inputAmount,
      decimals: tokenDecimals,
    },
    {
      programAddress: mintInfo.programAddress,
    }
  );
  const depositIx = SvmSpokeClient.getDepositInstruction(depositInput);
  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) =>
      createVaultAtaIfNeeded ? appendTransactionMessageInstruction(getCreateAssociatedTokenIdempotentIx(), tx) : tx,
    (tx) => appendTransactionMessageInstruction(approveIx, tx),
    (tx) => appendTransactionMessageInstruction(depositIx, tx)
  );
};

/**
 * Creates a request slow fill instruction.
 * @param signer - The signer of the transaction.
 * @param solanaClient - The Solana client.
 * @param depositInput - The deposit input.
 * @returns The request slow fill instruction.
 */
export const createRequestSlowFillInstruction = async (
  signer: TransactionSigner,
  solanaClient: SVMProvider,
  depositInput: SvmSpokeClient.RequestSlowFillInput
) => {
  const requestSlowFillIx = SvmSpokeClient.getRequestSlowFillInstruction(depositInput);

  return pipe(await createDefaultTransaction(solanaClient, signer), (tx) =>
    appendTransactionMessageInstruction(requestSlowFillIx, tx)
  );
};

/**
 * Creates a close fill PDA instruction.
 * @param signer - The signer of the transaction.
 * @param solanaClient - The Solana client.
 * @param fillStatusPda - The fill status PDA.
 * @returns The close fill PDA instruction.
 */
export const createCloseFillPdaInstruction = async (
  signer: TransactionSigner,
  solanaClient: SVMProvider,
  fillStatusPda: Address
) => {
  const closeFillPdaIx = SvmSpokeClient.getCloseFillPdaInstruction({
    signer,
    state: await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    fillStatus: fillStatusPda,
  });
  return pipe(await createDefaultTransaction(solanaClient, signer), (tx) =>
    appendTransactionMessageInstruction(closeFillPdaIx, tx)
  );
};

export const createReceiveMessageInstruction = async (
  signer: TransactionSigner,
  solanaClient: SVMProvider,
  input: MessageTransmitterClient.ReceiveMessageInput,
  remainingAccounts: IAccountMeta<string>[]
) => {
  const receiveMessageIx = await MessageTransmitterClient.getReceiveMessageInstruction(input);
  (receiveMessageIx.accounts as IAccountMeta<string>[]).push(...remainingAccounts);
  return pipe(await createDefaultTransaction(solanaClient, signer), (tx) =>
    appendTransactionMessageInstruction(receiveMessageIx, tx)
  );
};

export async function getAssociatedTokenAddress(
  owner: SvmAddress,
  mint: SvmAddress,
  tokenProgramId: Address<string> = TOKEN_PROGRAM_ADDRESS
): Promise<Address<string>> {
  const encoder = getAddressEncoder();
  const [associatedToken] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [encoder.encode(toAddress(owner)), encoder.encode(tokenProgramId), encoder.encode(toAddress(mint))],
  });
  return associatedToken;
}

export function getRelayDataHash(relayData: RelayData, destinationChainId: number): string {
  const addressEncoder = getAddressEncoder();
  const uint64Encoder = getU64Encoder();
  const uint32Encoder = getU32Encoder();

  assert(relayData.message.startsWith("0x"), "Message must be a hex string");
  const encodeAddress = (addr: string, chainId: number) =>
    Uint8Array.from(addressEncoder.encode(toAddress(toAddressType(addr, chainId))));

  const contentToHash = Buffer.concat([
    encodeAddress(relayData.depositor, relayData.originChainId),
    encodeAddress(relayData.recipient, destinationChainId),
    encodeAddress(relayData.exclusiveRelayer, destinationChainId),
    encodeAddress(relayData.inputToken, relayData.originChainId),
    encodeAddress(relayData.outputToken, destinationChainId),
    Uint8Array.from(uint64Encoder.encode(BigInt(relayData.inputAmount.toString()))),
    Uint8Array.from(uint64Encoder.encode(BigInt(relayData.outputAmount.toString()))),
    Uint8Array.from(uint64Encoder.encode(BigInt(relayData.originChainId.toString()))),
    arrayify(hexZeroPad(hexlify(relayData.depositId), 32)),
    Uint8Array.from(uint32Encoder.encode(relayData.fillDeadline)),
    Uint8Array.from(uint32Encoder.encode(relayData.exclusivityDeadline)),
    hashNonEmptyMessage(Buffer.from(arrayify(relayData.message))),
    Uint8Array.from(uint64Encoder.encode(BigInt(destinationChainId))),
  ]);
  return keccak256(contentToHash);
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
  provider: SVMProvider,
  fillStatusPdas: Address[],
  relayDataArray: RelayData[]
): Promise<(FillStatus | undefined)[]> {
  const chunkSize = 100; // SVM method getMultipleAccounts allows a max of 100 addresses per request
  const currentSlot = await provider.getSlot({ commitment: "confirmed" }).send();

  const [pdaAccounts, currentSlotTimestamp] = await Promise.all([
    Promise.all(
      chunk(fillStatusPdas, chunkSize).map((chunk) =>
        fetchEncodedAccounts(provider, chunk, { commitment: "confirmed" })
      )
    ),
    provider.getBlockTime(currentSlot).send(),
  ]);

  const fillStatuses = pdaAccounts.flat().map((account, index) => {
    // If the PDA exists, we can fetch the status directly.
    if (account.exists) {
      const decodedAccount = decodeFillStatusAccount(account);
      return decodedAccount.data.status;
    }
    // If the PDA doesn't exist and the deadline hasn't passed yet, the deposit must be unfilled,
    // since PDAs can't be closed before the fill deadline.
    else if (Number(currentSlotTimestamp) < relayDataArray[index].fillDeadline) {
      return FillStatus.Unfilled;
    }
    // If the PDA doesn't exist and the fill deadline has passed, then the status can't be determined and is set to undefined.
    return undefined;
  });

  return fillStatuses;
}

/**
 * Returns the delegate PDA for deposit.
 */
export async function getDepositDelegatePda(
  depositData: {
    depositor: Address<string>;
    recipient: Address<string>;
    inputToken: Address<string>;
    outputToken: Address<string>;
    inputAmount: bigint;
    outputAmount: bigint;
    destinationChainId: bigint;
    exclusiveRelayer: Address<string>;
    quoteTimestamp: bigint;
    fillDeadline: bigint;
    exclusivityParameter: bigint;
    message: Uint8Array;
  },
  programId: Address<string>
): Promise<Address<string>> {
  const addrEnc = getAddressEncoder();
  const u64 = getU64Encoder();
  const u32 = getU32Encoder();

  const parts: Uint8Array[] = [
    Uint8Array.from(addrEnc.encode(depositData.depositor)),
    Uint8Array.from(addrEnc.encode(depositData.recipient)),
    Uint8Array.from(addrEnc.encode(depositData.inputToken)),
    Uint8Array.from(addrEnc.encode(depositData.outputToken)),
    Uint8Array.from(u64.encode(depositData.inputAmount)),
    Uint8Array.from(u64.encode(depositData.outputAmount)),
    Uint8Array.from(u64.encode(depositData.destinationChainId)),
    Uint8Array.from(addrEnc.encode(depositData.exclusiveRelayer)),
    Uint8Array.from(u32.encode(depositData.quoteTimestamp)),
    Uint8Array.from(u32.encode(depositData.fillDeadline)),
    Uint8Array.from(u32.encode(depositData.exclusivityParameter)),
    Uint8Array.from(u32.encode(BigInt(depositData.message.length))),
    depositData.message,
  ];

  const seedHash = Buffer.from(keccak256(Buffer.concat(parts)).slice(2), "hex");

  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from("delegate"), seedHash],
  });

  return pda;
}

/**
 * Returns the delegate PDA for depositNow.
 */
export async function getDepositNowDelegatePda(
  depositData: {
    depositor: Address<string>;
    recipient: Address<string>;
    inputToken: Address<string>;
    outputToken: Address<string>;
    inputAmount: bigint;
    outputAmount: bigint;
    destinationChainId: bigint;
    exclusiveRelayer: Address<string>;
    fillDeadlineOffset: bigint;
    exclusivityPeriod: bigint;
    message: Uint8Array;
  },
  programId: Address<string>
): Promise<Address<string>> {
  const addrEnc = getAddressEncoder();
  const u64 = getU64Encoder();
  const u32 = getU32Encoder();

  const parts: Uint8Array[] = [
    Uint8Array.from(addrEnc.encode(depositData.depositor)),
    Uint8Array.from(addrEnc.encode(depositData.recipient)),
    Uint8Array.from(addrEnc.encode(depositData.inputToken)),
    Uint8Array.from(addrEnc.encode(depositData.outputToken)),
    Uint8Array.from(u64.encode(depositData.inputAmount)),
    Uint8Array.from(u64.encode(depositData.outputAmount)),
    Uint8Array.from(u64.encode(depositData.destinationChainId)),
    Uint8Array.from(addrEnc.encode(depositData.exclusiveRelayer)),
    Uint8Array.from(u32.encode(depositData.fillDeadlineOffset)),
    Uint8Array.from(u32.encode(depositData.exclusivityPeriod)),
    Uint8Array.from(u32.encode(BigInt(depositData.message.length))),
    depositData.message,
  ];

  const seedHash = Buffer.from(keccak256(Buffer.concat(parts)).slice(2), "hex");

  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from("delegate"), seedHash],
  });

  return pda;
}

/**
 * Returns the fill-delegate PDA for fillRelay.
 */
export async function getFillRelayDelegatePda(
  relayHash: Uint8Array,
  repaymentChainId: bigint,
  repaymentAddress: Address<string>,
  programId: Address<string>
): Promise<Address<string>> {
  const addrEnc = getAddressEncoder();
  const u64 = getU64Encoder();

  const parts: Uint8Array[] = [
    relayHash,
    Uint8Array.from(u64.encode(repaymentChainId)),
    Uint8Array.from(addrEnc.encode(repaymentAddress)),
  ];

  const seedHash = Buffer.from(keccak256(Buffer.concat(parts)).slice(2), "hex");

  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from("delegate"), seedHash],
  });

  return pda;
}
