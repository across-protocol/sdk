import { MessageTransmitterClient, SvmSpokeClient, TokenMessengerMinterClient } from "@across-protocol/contracts";
import { decodeFillStatusAccount, fetchState } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";
import { decodeMessageHeader, hashNonEmptyMessage } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  Mint,
  TOKEN_PROGRAM_ADDRESS,
  fetchMint,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import {
  Account,
  AccountRole,
  Address,
  FetchAccountConfig,
  IAccountMeta,
  IInstruction,
  KeyPairSigner,
  ReadonlyUint8Array,
  appendTransactionMessageInstruction,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU32Encoder,
  getU64Encoder,
  pipe,
  signTransactionMessageWithSigners,
  some,
  type TransactionSigner,
  type WritableAccount,
  type ReadonlyAccount,
} from "@solana/kit";
import assert from "assert";
import { arrayify } from "ethers/lib/utils";
import { Logger } from "winston";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "../../constants";
import { DepositWithBlock, FillStatus, FillWithBlock, RelayData, RelayExecutionEventInfo } from "../../interfaces";
import {
  BigNumber,
  EvmAddress,
  Address as SdkAddress,
  SvmAddress,
  bs58,
  chainIsProd,
  chainIsSvm,
  chunk,
  delay,
  isUnsafeDepositId,
  keccak256,
  mapAsync,
  toAddressType,
} from "../../utils";
import {
  createDefaultTransaction,
  getCCTPNoncePda,
  getEventAuthority,
  getFillStatusPda,
  getSelfAuthority,
  getStatePda,
  isDepositForBurnEvent,
  simulateAndDecode,
  toAddress,
  unwrapEventData,
  getRootBundlePda,
  getAcrossPlusMessageDecoder,
  getAccountMeta,
  toSvmRelayData,
  getInstructionParamsPda,
  type AcrossPlusMessage,
  toSvmRelayData,
} from "./";
import { SvmCpiEventsClient } from "./eventsClient";
import { SVM_BLOCK_NOT_AVAILABLE, SVM_SLOT_SKIPPED, isSolanaError } from "./provider";
import { AttestedCCTPMessage, SVMEventNames, SVMProvider } from "./types";
import {
  getEmergencyDeleteRootBundleRootBundleId,
  getNearestSlotTime,
  isEmergencyDeleteRootBundleMessageBody,
  isRelayRootBundleMessageBody,
} from "./utils";

/**
 * @note: Average Solana slot duration is about 400-500ms. We can be conservative
 *        and choose 400 to ensure that the most slots get included in our ranges
 */
export const SLOT_DURATION_MS = 400;

type ProtoFill = Omit<RelayData, "recipient" | "outputToken"> & {
  destinationChainId: number;
  recipient: SvmAddress;
  outputToken: SvmAddress;
};

/**
 * Retrieves the chain time at a particular slot.
 */
export function getTimestampForSlot(
  provider: SVMProvider,
  slotNumber: bigint,
  maxRetries = 2
): Promise<number | undefined> {
  return _callGetTimestampForSlotWithRetry(provider, slotNumber, 0, maxRetries);
}

async function _callGetTimestampForSlotWithRetry(
  provider: SVMProvider,
  slotNumber: bigint,
  retryAttempt: number,
  maxRetries: number
): Promise<number | undefined> {
  // @note: getBlockTime receives a slot number, not a block number.
  let _timestamp: bigint;

  try {
    _timestamp = await provider.getBlockTime(slotNumber).send();
  } catch (err) {
    if (!isSolanaError(err)) {
      throw err;
    }

    const { __code: code } = err.context;
    const slot = slotNumber.toString();
    switch (err.context.__code) {
      case SVM_SLOT_SKIPPED:
        return undefined;

      case SVM_BLOCK_NOT_AVAILABLE: {
        // Implement exponential backoff with jitter where the # of seconds to wait is = 2^retryAttempt + jitter
        // e.g. First two retry delays are ~1.5s and ~2.5s.
        const delaySeconds = 2 ** retryAttempt + Math.random();
        if (retryAttempt >= maxRetries) {
          throw new Error(`Timeout on SVM getBlockTime() for slot ${slot} after ${retryAttempt} retry attempts`);
        }
        await delay(delaySeconds);
        return _callGetTimestampForSlotWithRetry(provider, slotNumber, ++retryAttempt, maxRetries);
      }

      default:
        throw new Error(`Unhandled SVM getBlockTime() error for slot ${slot}: ${code}`, { cause: err });
    }
  }

  const timestamp = Number(_timestamp);
  assert(BigInt(timestamp) === _timestamp, `Unexpected SVM block timestamp: ${_timestamp}`); // No truncation.

  return timestamp;
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
  const { slot: currentSlot } = await getNearestSlotTime(provider);

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

  const unwrappedDepositEvent = unwrapEventData(depositEvent.data, ["depositId", "outputAmount"]) as Record<
    string,
    unknown
  >;
  const destinationChainId = unwrappedDepositEvent.destinationChainId as number;
  // Return the deposit event with block info
  return {
    txnRef: depositEvent.signature.toString(),
    blockNumber: Number(depositEvent.slot),
    txnIndex: 0,
    logIndex: 0,
    ...unwrappedDepositEvent,
    depositor: toAddressType(unwrappedDepositEvent.depositor as string, CHAIN_IDs.SOLANA),
    recipient: toAddressType(unwrappedDepositEvent.recipient as string, destinationChainId),
    inputToken: toAddressType(unwrappedDepositEvent.inputToken as string, CHAIN_IDs.SOLANA),
    outputToken: toAddressType(unwrappedDepositEvent.outputToken as string, destinationChainId),
    exclusiveRelayer: toAddressType(unwrappedDepositEvent.exclusiveRelayer as string, destinationChainId),
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
  let toSlot = BigInt(atHeight ?? 0);

  // If no specific slot is requested, try fetching the current status from the PDA
  if (atHeight === undefined) {
    const commitment = "confirmed";
    const [fillStatusAccount, { slot: currentSlot, timestamp }] = await Promise.all([
      fetchEncodedAccount(provider, fillStatusPda, { commitment }),
      getNearestSlotTime(provider, { commitment }),
    ]);
    toSlot = currentSlot;

    // If the PDA exists, return the stored fill status
    if (fillStatusAccount.exists) {
      const decodedAccountData = decodeFillStatusAccount(fillStatusAccount);
      return decodedAccountData.data.status;
    }
    // If the PDA doesn't exist and the deadline hasn't passed yet, the deposit must be unfilled,
    // since PDAs can't be closed before the fill deadline.
    else if (timestamp < relayData.fillDeadline) {
      return FillStatus.Unfilled;
    }
  }

  // If status couldn't be determined from the PDA, or if a specific slot was requested, reconstruct from events.
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
  const toSlot = atHeight ? BigInt(atHeight) : (await getNearestSlotTime(provider)).slot;

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
  toSlot ??= Number((await getNearestSlotTime(svmEventsClient.getRpc())).slot);

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
    const eventData = unwrapEventData(rawFillEvent.data, ["depositId", "inputAmount"]) as FillWithBlock & {
      depositor: string;
      recipient: string;
      inputToken: string;
      outputToken: string;
      exclusiveRelayer: string;
      relayer: string;
      relayExecutionInfo: RelayExecutionEventInfo & { updatedRecipient: string };
    };
    const originChainId = eventData.originChainId;
    const parsedFillEvent = {
      ...eventData,
      transactionHash: rawFillEvent.signature,
      blockNumber: Number(rawFillEvent.slot),
      transactionIndex: 0,
      logIndex: 0,
      destinationChainId,
      inputToken: toAddressType(eventData.inputToken, originChainId),
      outputToken: toAddressType(eventData.outputToken, destinationChainId),
      relayer: toAddressType(eventData.relayer, destinationChainId),
      exclusiveRelayer: toAddressType(eventData.exclusiveRelayer, destinationChainId),
      depositor: toAddressType(eventData.depositor, originChainId),
      recipient: toAddressType(eventData.recipient, destinationChainId),
      relayExecutionInfo: {
        ...eventData.relayExecutionInfo,
        updatedRecipient: eventData.relayExecutionInfo.updatedRecipient,
      },
    } as FillWithBlock;
    return parsedFillEvent;
  }

  return undefined;
}

/**
 * @param spokePool Address (program ID) of the SvmSpoke.
 * @param relayData RelayData instance, supplemented with destinationChainId
 * @param relayer Address of the relayer filling the deposit.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export async function fillRelayInstruction(
  spokePool: SvmAddress,
  relayData: ProtoFill,
  signer: TransactionSigner<string>,
  recipientTokenAccount: Address<string>,
  repaymentAddress: EvmAddress | SvmAddress,
  repaymentChainId: number
) {
  const program = toAddress(spokePool);
  assert(
    repaymentAddress.isValidOn(repaymentChainId),
    `Invalid repayment address for chain ${repaymentChainId}: ${repaymentAddress.toNative()}.`
  );

  const _relayDataHash = getRelayDataHash(relayData, relayData.destinationChainId);
  const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

  const relayer = SvmAddress.from(signer.address);

  const [statePda, fillStatusPda, eventAuthority, delegatePda, relayerTokenAccount] = await Promise.all([
    getStatePda(program),
    getFillStatusPda(program, relayData, relayData.destinationChainId),
    getEventAuthority(program),
    getFillRelayDelegatePda(relayDataHash, BigInt(repaymentChainId), signer.address, program),
    getAssociatedTokenAddress(relayer, relayData.outputToken),
  ]);

  const svmRelayData = toSvmRelayData(relayData);
  return SvmSpokeClient.getFillRelayInstruction({
    signer,
    state: statePda,
    delegate: toAddress(SvmAddress.from(delegatePda.toString())),
    mint: svmRelayData.outputToken,
    relayerTokenAccount: relayerTokenAccount,
    recipientTokenAccount: recipientTokenAccount,
    fillStatus: fillStatusPda,
    eventAuthority,
    program,
    relayHash: relayDataHash,
    relayData: some(svmRelayData),
    repaymentChainId: some(BigInt(repaymentChainId)),
    repaymentAddress: some(toAddress(repaymentAddress)),
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
 * @notice Return the fillRelay transaction for a given deposit
 * @param spokePoolAddr Address of the spoke pool we're trying to fill through
 * @param solanaClient RPC client to interact with Solana chain
 * @param relayData RelayData instance, supplemented with destinationChainId
 * @param signer signer associated with the relayer creating a Fill. Can be VoidSigner for gas estimation
 * @param repaymentChainId Chain id where relayer repayment is desired
 * @param repaymentAddress Address to which repayment will go to on repaymentChainId
 * @returns FillRelay transaction
 */
export async function getFillRelayTx(
  spokePoolAddr: SvmAddress,
  solanaClient: SVMProvider,
  relayData: Omit<RelayData, "recipient" | "outputToken"> & {
    destinationChainId: number;
    recipient: SvmAddress;
    outputToken: SvmAddress;
  },
  signer: TransactionSigner,
  repaymentChainId: number,
  repaymentAddress: SdkAddress
) {
  const svmRelayData = toSvmRelayData(relayData);

  assert(
    repaymentAddress.isValidOn(repaymentChainId),
    `getFillRelayTx: repayment address ${repaymentAddress} not valid on chain ${repaymentChainId})`
  );

  const program = toAddress(spokePoolAddr);
  const _relayDataHash = getRelayDataHash(relayData, relayData.destinationChainId);
  const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

  const [state, delegate, mintInfo, fillStatus, eventAuthority] = await Promise.all([
    getStatePda(program),
    getFillRelayDelegatePda(relayDataHash, BigInt(repaymentChainId), toAddress(repaymentAddress), program),
    getMintInfo(solanaClient, svmRelayData.outputToken),
    getFillStatusPda(program, relayData, relayData.destinationChainId),
    getEventAuthority(program),
  ]);

  const [recipientAta, relayerAta] = await Promise.all([
    getAssociatedTokenAddress(relayData.recipient, relayData.outputToken, mintInfo.programAddress),
    getAssociatedTokenAddress(SvmAddress.from(signer.address), relayData.outputToken, mintInfo.programAddress),
  ]);

  // Add remaining accounts if the relayData has a non-empty message.
  // @dev ! since in the context of creating a `fillRelayTx`, `relayData` must be defined.
  const remainingAccounts: (WritableAccount | ReadonlyAccount)[] = [];
  if (relayData.message !== "0x") {
    const acrossPlusMessage = deserializeMessage(relayData.message);
    // The first `remainingAccount` _must_ be the handler address.
    // https://github.com/across-protocol/contracts/blob/3310f8dc716407a5f97ef5fd2eae63df83251f2f/programs/svm-spoke/src/utils/message_utils.rs#L36.
    remainingAccounts.push(getAccountMeta(acrossPlusMessage.handler, true));
    remainingAccounts.push(
      ...acrossPlusMessage.accounts.map((account, idx) =>
        getAccountMeta(account, idx < acrossPlusMessage.accounts.length - acrossPlusMessage.read_only_len)
      )
    );
  }

  const fillInput: SvmSpokeClient.FillRelayInput = {
    signer: signer,
    state,
    delegate,
    mint: svmRelayData.outputToken,
    relayerTokenAccount: relayerAta,
    recipientTokenAccount: recipientAta,
    fillStatus,
    tokenProgram: mintInfo.programAddress,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    eventAuthority,
    program,
    relayHash: relayDataHash,
    relayData: svmRelayData,
    repaymentChainId: BigInt(repaymentChainId),
    repaymentAddress: toAddress(repaymentAddress),
  };
  // Pass createRecipientAtaIfNeeded =true to the createFillInstruction function to create the recipient token account
  // if it doesn't exist.
  return createFillInstruction(
    signer,
    solanaClient,
    fillInput,
    svmRelayData,
    mintInfo.data.decimals,
    true,
    remainingAccounts
  );
}

/**
 * Creates a fill instruction with an instruction params PDA as the relayData input.
 * @param spokePoolAddr Address of the spoke pool we're trying to fill through
 * @param solanaClient RPC client to interact with Solana chain
 * @param relayData RelayData instance, supplemented with destinationChainId
 * @param signer signer associated with the relayer creating a Fill. Can be VoidSigner for gas estimation
 * @param repaymentChainId Chain id where relayer repayment is desired
 * @param repaymentAddress Address to which repayment will go to on repaymentChainId
 * @returns FillRelay transaction
 */
export async function getIPFillRelayTx(
  spokePoolAddr: SvmAddress,
  solanaClient: SVMProvider,
  relayData: Omit<RelayData, "recipient" | "outputToken"> & {
    destinationChainId: number;
    recipient: SvmAddress;
    outputToken: SvmAddress;
  },
  signer: TransactionSigner,
  repaymentChainId: number,
  repaymentAddress: SdkAddress
) {
  const program = toAddress(spokePoolAddr);
  const _relayDataHash = getRelayDataHash(relayData, relayData.destinationChainId);
  const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

  const [state, delegate, instructionParams] = await Promise.all([
    getStatePda(program),
    getFillRelayDelegatePda(relayDataHash, BigInt(repaymentChainId), toAddress(repaymentAddress), program),
    getInstructionParamsPda(program, signer.address),
  ]);

  const mint = toAddress(relayData.outputToken);
  const mintInfo = await getMintInfo(solanaClient, mint);

  const [recipientAta, relayerAta, fillStatus, eventAuthority] = await Promise.all([
    getAssociatedTokenAddress(relayData.recipient, relayData.outputToken, mintInfo.programAddress),
    getAssociatedTokenAddress(SvmAddress.from(signer.address), relayData.outputToken, mintInfo.programAddress),
    getFillStatusPda(program, relayData, relayData.destinationChainId),
    getEventAuthority(program),
  ]);

  // Add remaining accounts if the relayData has a non-empty message.
  // @dev ! since in the context of creating a `fillRelayTx`, `relayData` must be defined.
  const remainingAccounts: (WritableAccount | ReadonlyAccount)[] = [];
  if (relayData.message !== "0x") {
    const acrossPlusMessage = deserializeMessage(relayData.message);
    // The first `remainingAccount` _must_ be the handler address.
    // https://github.com/across-protocol/contracts/blob/3310f8dc716407a5f97ef5fd2eae63df83251f2f/programs/svm-spoke/src/utils/message_utils.rs#L36.
    remainingAccounts.push(getAccountMeta(acrossPlusMessage.handler, true));
    remainingAccounts.push(
      ...acrossPlusMessage.accounts.map((account, idx) =>
        getAccountMeta(account, idx < acrossPlusMessage.accounts.length - acrossPlusMessage.read_only_len)
      )
    );
  }

  const fillInput: SvmSpokeClient.FillRelayInput = {
    signer: signer,
    state,
    delegate,
    mint,
    relayerTokenAccount: relayerAta,
    recipientTokenAccount: recipientAta,
    fillStatus,
    tokenProgram: mintInfo.programAddress,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    eventAuthority,
    program,
    instructionParams,
    relayHash: relayDataHash,
    relayData: null,
    repaymentChainId: null,
    repaymentAddress: null,
  };

  // Pass createRecipientAtaIfNeeded =true to the createFillInstruction function to create the recipient token account
  // if it doesn't exist.
  return createFillInstruction(
    signer,
    solanaClient,
    fillInput,
    { outputAmount: relayData.outputAmount.toBigInt(), recipient: toAddress(relayData.recipient) },
    mintInfo.data.decimals,
    true,
    remainingAccounts
  );
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
  relayData: Pick<SvmSpokeClient.RelayDataArgs, "outputAmount" | "recipient">,
  tokenDecimals: number,
  createRecipientAtaIfNeeded: boolean = true,
  remainingAccounts: (WritableAccount | ReadonlyAccount)[] = []
) => {
  const mintInfo = await getMintInfo(solanaClient, fillInput.mint);
  const approveIx = getApproveCheckedInstruction(
    {
      source: fillInput.relayerTokenAccount,
      mint: fillInput.mint,
      delegate: fillInput.delegate,
      owner: fillInput.signer,
      amount: relayData.outputAmount,
      decimals: tokenDecimals,
    },
    {
      programAddress: mintInfo.programAddress,
    }
  );

  const getCreateAssociatedTokenIdempotentIx = () =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      owner: relayData.recipient,
      mint: fillInput.mint,
      ata: fillInput.recipientTokenAccount,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      tokenProgram: fillInput.tokenProgram,
    });

  const createFillIx = SvmSpokeClient.getFillRelayInstruction(fillInput);

  // Add remaining accounts.
  createFillIx.accounts.push(...remainingAccounts);

  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) =>
      createRecipientAtaIfNeeded ? appendTransactionMessageInstruction(getCreateAssociatedTokenIdempotentIx(), tx) : tx,
    (tx) => appendTransactionMessageInstruction(approveIx, tx),
    (tx) => appendTransactionMessageInstruction(createFillIx, tx)
  );
};

export function deserializeMessage(_message: string): AcrossPlusMessage {
  const message = new Uint8Array(Buffer.from(_message.slice(2), "hex"));
  // Add remaining accounts if the relayData has a non-empty message.
  // @dev ! since in the context of creating a `fillRelayTx`, `relayData` must be defined.
  const acrossPlusMessageDecoder = getAcrossPlusMessageDecoder();
  return acrossPlusMessageDecoder.decode(message);
}

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
  const mintInfo = await getMintInfo(solanaClient, depositInput.mint);
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
 * @param requestSlowFillInput - The input arguments for the `requestSlowFill` instruction.
 * @returns The request slow fill instruction.
 */
export const createRequestSlowFillInstruction = async (
  signer: TransactionSigner,
  solanaClient: SVMProvider,
  requestSlowFillInput: SvmSpokeClient.RequestSlowFillInput
) => {
  const requestSlowFillIx = SvmSpokeClient.getRequestSlowFillInstruction(requestSlowFillInput);

  return pipe(await createDefaultTransaction(solanaClient, signer), (tx) =>
    appendTransactionMessageInstruction(requestSlowFillIx, tx)
  );
};

/**
 * @notice Return the requestSlowFill transaction for a given deposit
 * @param spokePoolAddr Address of the spoke pool we're trying to fill through
 * @param solanaClient RPC client to interact with Solana chain
 * @param relayData RelayData instance, supplemented with destinationChainId
 * @param signer signer associated with the relayer creating a Fill.
 * @returns requestSlowFill transaction
 */
export async function getSlowFillRequestTx(
  spokePoolAddr: SvmAddress,
  solanaClient: SVMProvider,
  relayData: Omit<RelayData, "recipient" | "outputToken"> & {
    destinationChainId: number;
    recipient: SvmAddress;
    outputToken: SvmAddress;
  },
  signer: TransactionSigner
) {
  const program = toAddress(spokePoolAddr);
  const relayDataHash = getRelayDataHash(relayData, relayData.destinationChainId);

  const [state, fillStatus, eventAuthority] = await Promise.all([
    getStatePda(program),
    getFillStatusPda(program, relayData, relayData.destinationChainId),
    getEventAuthority(program),
  ]);

  const svmRelayData = toSvmRelayData(relayData);
  const requestSlowFillInput: SvmSpokeClient.RequestSlowFillInput = {
    signer,
    state,
    fillStatus,
    eventAuthority,
    program,
    relayHash: arrayify(relayDataHash),
    relayData: svmRelayData,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
  };

  return createRequestSlowFillInstruction(signer, solanaClient, requestSlowFillInput);
}

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
  const receiveMessageIx = MessageTransmitterClient.getReceiveMessageInstruction(input);
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
  assert(relayData.message.startsWith("0x"), "Message must be a hex string");
  const uint64Encoder = getU64Encoder();

  const svmRelayData = toSvmRelayData(relayData);
  const relayDataEncoder = SvmSpokeClient.getRelayDataEncoder();
  const encodedRelayData = relayDataEncoder.encode(svmRelayData);
  const encodedMessage = Buffer.from(relayData.message.slice(2), "hex");

  // Reformat the encoded relay data the same way it is done in the SvmSpoke:
  // https://github.com/across-protocol/contracts/blob/3310f8dc716407a5f97ef5fd2eae63df83251f2f/programs/svm-spoke/src/utils/merkle_proof_utils.rs#L5
  const messageOffset = encodedRelayData.length - 4 - encodedMessage.length;
  const contentToHash = Buffer.concat([
    encodedRelayData.slice(0, messageOffset),
    hashNonEmptyMessage(encodedMessage),
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
  const commitment = "confirmed";

  const [pdaAccounts, { timestamp }] = await Promise.all([
    Promise.all(chunk(fillStatusPdas, chunkSize).map((chunk) => fetchEncodedAccounts(provider, chunk, { commitment }))),
    getNearestSlotTime(provider, { commitment }),
  ]);

  const fillStatuses = pdaAccounts.flat().map((account, index) => {
    // If the PDA exists, we can fetch the status directly.
    if (account.exists) {
      const decodedAccount = decodeFillStatusAccount(account);
      return decodedAccount.data.status;
    }

    // If the PDA doesn't exist and the deadline hasn't passed yet, the deposit must be unfilled,
    // since PDAs can't be closed before the fill deadline.
    if (timestamp < relayDataArray[index].fillDeadline) {
      return FillStatus.Unfilled;
    }

    // If the PDA doesn't exist and the fill deadline has passed, then the status can't be determined and is set to undefined.
    return undefined;
  });

  return fillStatuses;
}

/**
 * Returns a set of instructions to execute to fill a relay via instruction params.
 * @param spokePool The program ID of the Solana spoke pool.
 * @param relayData The relay data to write to the instruction params PDA.
 * @param signer The transaction signer and authority of the instruction params PDA.
 * @param maxWriteSize The maximum fragment size to write to instruction params.
 */
export async function getFillRelayViaInstructionParamsInstructions(
  spokePool: Address<string>,
  relayData: RelayData,
  repaymentChainId: number,
  repaymentAddress: SdkAddress,
  signer: TransactionSigner<string>,
  maxWriteSize = 450
): Promise<IInstruction[]> {
  const instructionParams = await getInstructionParamsPda(spokePool, signer.address);

  const relayDataEncoder = SvmSpokeClient.getFillRelayParamsEncoder();
  const svmRelayData = toSvmRelayData(relayData);
  const encodedRelayData = relayDataEncoder.encode({
    relayData: svmRelayData,
    repaymentChainId,
    repaymentAddress: toAddress(repaymentAddress),
  });

  const initInstructionParamsIx = SvmSpokeClient.getInitializeInstructionParamsInstruction({
    signer,
    instructionParams,
    totalSize: encodedRelayData.length,
  });
  const instructions: IInstruction[] = [initInstructionParamsIx];

  for (let i = 0; i <= encodedRelayData.length / maxWriteSize; ++i) {
    const offset = i * maxWriteSize;
    const offsetEnd = Math.min(offset + maxWriteSize, encodedRelayData.length);
    const fragment = encodedRelayData.slice(offset, offsetEnd);
    const writeInstructionParamsIx = SvmSpokeClient.getWriteInstructionParamsFragmentInstruction({
      signer,
      instructionParams,
      offset,
      fragment,
    });
    instructions.push(writeInstructionParamsIx);
  }
  return instructions;
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
    outputAmount: ReadonlyUint8Array;
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
    Uint8Array.from(depositData.outputAmount),
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
    outputAmount: ReadonlyUint8Array;
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
    Uint8Array.from(depositData.outputAmount),
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

/**
 * Checks if a CCTP message has been processed.
 * @param solanaClient The Solana client.
 * @param signer The signer of the transaction.
 * @param nonce The nonce to check.
 * @param sourceDomain The source domain.
 * @returns True if the message has been processed, false otherwise.
 */
export const hasCCTPV1MessageBeenProcessed = async (
  solanaClient: SVMProvider,
  signer: KeyPairSigner,
  nonce: number,
  sourceDomain: number
): Promise<boolean> => {
  const noncePda = await getCCTPNoncePda(solanaClient, signer, nonce, sourceDomain);
  const isNonceUsedIx = await MessageTransmitterClient.getIsNonceUsedInstruction({
    nonce: nonce,
    usedNonces: noncePda,
  });
  const parserFunction = (buf: Buffer): boolean => {
    if (buf.length != 1) {
      throw new Error("Invalid buffer length for isNonceUsedIx");
    }
    return Boolean(buf[0]);
  };
  return await simulateAndDecode(solanaClient, isNonceUsedIx, signer, parserFunction);
};

/**
 * Returns the account metas for a tokenless message.
 * @returns The account metas for a tokenless message.
 */
export async function getAccountMetasForTokenlessMessage(
  solanaClient: SVMProvider,
  signer: KeyPairSigner,
  messageBytes: string
): Promise<IAccountMeta<string>[]> {
  const messageHex = messageBytes.slice(2);
  const messageHeader = decodeMessageHeader(Buffer.from(messageHex, "hex"));
  const programAddress = SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS;
  const statePda = await getStatePda(programAddress);
  const selfAuthority = await getSelfAuthority();
  const eventAuthority = await getEventAuthority(programAddress);

  const base: IAccountMeta<string>[] = [
    { address: statePda, role: AccountRole.READONLY },
    { address: selfAuthority, role: AccountRole.READONLY },
    { address: programAddress, role: AccountRole.READONLY },
  ];

  if (isRelayRootBundleMessageBody(messageHeader.messageBody)) {
    const {
      data: { rootBundleId },
    } = await SvmSpokeClient.fetchState(solanaClient, statePda);
    const rootBundle = await getRootBundlePda(programAddress, rootBundleId);

    return [
      ...base,
      { address: signer.address, role: AccountRole.WRITABLE },
      { address: statePda, role: AccountRole.WRITABLE },
      { address: rootBundle, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: eventAuthority, role: AccountRole.READONLY },
      { address: programAddress, role: AccountRole.READONLY },
    ];
  }

  if (isEmergencyDeleteRootBundleMessageBody(messageHeader.messageBody)) {
    const rootBundleId = getEmergencyDeleteRootBundleRootBundleId(messageHeader.messageBody);
    const rootBundle = await getRootBundlePda(programAddress, rootBundleId);

    return [
      ...base,
      { address: signer.address, role: AccountRole.READONLY },
      { address: statePda, role: AccountRole.READONLY },
      { address: rootBundle, role: AccountRole.WRITABLE },
      { address: eventAuthority, role: AccountRole.READONLY },
      { address: programAddress, role: AccountRole.READONLY },
    ];
  }

  return [
    ...base,
    { address: statePda, role: AccountRole.WRITABLE },
    { address: eventAuthority, role: AccountRole.READONLY },
    { address: programAddress, role: AccountRole.READONLY },
  ];
}

/**
 * Returns the account metas for a deposit message.
 * @param message The CCTP message.
 * @param hubChainId The chain ID of the hub.
 * @param tokenMessengerMinter The token messenger minter address.
 * @param recipientAta The ATA of the recipient address.
 * @returns The account metas for a deposit message.
 */
async function getAccountMetasForDepositMessage(
  message: AttestedCCTPMessage,
  hubChainId: number,
  tokenMessengerMinter: Address,
  recipientAta: SvmAddress
): Promise<IAccountMeta<string>[]> {
  const l1Usdc = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId]);
  const l2Usdc = SvmAddress.from(
    TOKEN_SYMBOLS_MAP.USDC.addresses[chainIsProd(hubChainId) ? CHAIN_IDs.SOLANA : CHAIN_IDs.SOLANA_DEVNET]
  );

  const [tokenMessengerPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["token_messenger"],
  });

  const [tokenMinterPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["token_minter"],
  });

  const [localTokenPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["local_token", bs58.decode(l2Usdc.toBase58())],
  });

  const [tokenMessengerEventAuthorityPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["__event_authority"],
  });

  const [custodyTokenAccountPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["custody", bs58.decode(l2Usdc.toBase58())],
  });

  // Define accounts dependent on deposit information.
  const [tokenPairPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: [
      new Uint8Array(Buffer.from("token_pair")),
      new Uint8Array(Buffer.from(String(message.sourceDomain))),
      new Uint8Array(Buffer.from(l1Usdc.toBytes32().slice(2), "hex")),
    ],
  });

  const [remoteTokenMessengerPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["remote_token_messenger", String(message.sourceDomain)],
  });

  return [
    { address: tokenMessengerPda, role: AccountRole.READONLY },
    { address: remoteTokenMessengerPda, role: AccountRole.READONLY },
    { address: tokenMinterPda, role: AccountRole.WRITABLE },
    { address: localTokenPda, role: AccountRole.WRITABLE },
    { address: tokenPairPda, role: AccountRole.READONLY },
    { address: toAddress(recipientAta), role: AccountRole.WRITABLE },
    { address: custodyTokenAccountPda, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: tokenMessengerEventAuthorityPda, role: AccountRole.READONLY },
    { address: tokenMessengerMinter, role: AccountRole.READONLY },
  ];
}

/**
 * Returns the CCTP v1 receive message transaction.
 * @param solanaClient The Solana client.
 * @param signer The signer of the transaction.
 * @param message The CCTP message.
 * @param hubChainId The chain ID of the hub.
 * @param recipientAta The ATA of the recipient address (used for token finalizations only).
 * @returns The CCTP v1 receive message transaction.
 */
export async function getCCTPV1ReceiveMessageTx(
  solanaClient: SVMProvider,
  signer: KeyPairSigner,
  message: AttestedCCTPMessage,
  hubChainId: number,
  recipientAta: SvmAddress
) {
  const [messageTransmitterPda] = await getProgramDerivedAddress({
    programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    seeds: ["message_transmitter"],
  });

  const [eventAuthorityPda] = await getProgramDerivedAddress({
    programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });

  const cctpMessageReceiver = isDepositForBurnEvent(message)
    ? TokenMessengerMinterClient.TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS
    : SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS;

  const [authorityPda] = await getProgramDerivedAddress({
    programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    seeds: ["message_transmitter_authority", bs58.decode(cctpMessageReceiver)],
  });

  // Notice: message.nonce is only valid for v1 messages
  const usedNonces = await getCCTPNoncePda(solanaClient, signer, message.nonce, message.sourceDomain);

  // Notice: for Svm tokenless messages, we currently only support very specific finalizations: Hub -> Spoke relayRootBundle calls
  const accountMetas: IAccountMeta<string>[] = isDepositForBurnEvent(message)
    ? await getAccountMetasForDepositMessage(
        message,
        hubChainId,
        TokenMessengerMinterClient.TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS,
        recipientAta
      )
    : await getAccountMetasForTokenlessMessage(solanaClient, signer, message.messageBytes);

  const messageBytes = message.messageBytes.startsWith("0x")
    ? Buffer.from(message.messageBytes.slice(2), "hex")
    : Buffer.from(message.messageBytes, "hex");

  const input: MessageTransmitterClient.ReceiveMessageInput = {
    program: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    payer: signer,
    caller: signer,
    authorityPda,
    messageTransmitter: messageTransmitterPda,
    eventAuthority: eventAuthorityPda,
    usedNonces,
    receiver: cctpMessageReceiver,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    message: messageBytes,
    attestation: Buffer.from(message.attestation.slice(2), "hex"),
  };

  return createReceiveMessageInstruction(signer, solanaClient, input, accountMetas);
}

/**
 * Finalizes CCTP deposits and messages on Solana.
 *
 * @param solanaClient The Solana client.
 * @param attestedMessages The CCTP messages to Solana.
 * @param signer A base signer to be converted into a Solana signer.
 * @param recipientAta The ATA of the recipient address (used for token finalizations only).
 * @param simulate Whether to simulate the transaction.
 * @param hubChainId The chain ID of the hub.
 * @returns A list of executed transaction signatures.
 */

export function finalizeCCTPV1Messages(
  solanaClient: SVMProvider,
  attestedMessages: AttestedCCTPMessage[],
  signer: KeyPairSigner,
  recipientAta: SvmAddress,
  simulate = false,
  hubChainId = 1
): Promise<string[]> {
  return mapAsync(attestedMessages, async (message) => {
    const receiveMessageIx = await getCCTPV1ReceiveMessageTx(solanaClient, signer, message, hubChainId, recipientAta);

    if (simulate) {
      const result = await solanaClient
        .simulateTransaction(
          getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(receiveMessageIx)),
          {
            encoding: "base64",
          }
        )
        .send();
      if (result.value.err) {
        throw new Error(result.value.err.toString());
      }
      return "";
    }

    const signedTransaction = await signTransactionMessageWithSigners(receiveMessageIx);
    const signature = getSignatureFromTransaction(signedTransaction);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    await solanaClient
      .sendTransaction(encodedTransaction, { preflightCommitment: "confirmed", encoding: "base64" })
      .send();

    return signature;
  });
}

export async function getMintInfo(
  solanaClient: SVMProvider,
  mint: Address<string>,
  config?: FetchAccountConfig
): Promise<Account<Mint, string>> {
  return await fetchMint(solanaClient, mint, config);
}
