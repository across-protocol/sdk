import assert from "assert";
import { SpokePoolClient } from "../clients";
import { DEFAULT_CACHING_TTL, EMPTY_MESSAGE, UNDEFINED_MESSAGE_HASH, ZERO_BYTES } from "../constants";
import {
  CachingMechanismInterface,
  Deposit,
  DepositWithBlock,
  Fill,
  RelayData,
  SlowFillRequest,
  ConvertedRelayData,
  ConvertedFill,
} from "../interfaces";
import { getMessageHash, isUnsafeDepositId } from "./SpokeUtils";
import { getNetworkName } from "./NetworkUtils";
import { bnZero } from "./BigNumberUtils";
import { getDepositInCache, getDepositKey, setDepositInCache } from "./CachingUtils";
import { getCurrentTime } from "./TimeUtils";
import { isDefined } from "./TypeGuards";
import { isDepositFormedCorrectly } from "./ValidatorUtils";

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.

export enum InvalidFill {
  DepositIdInvalid = 0, // Deposit ID seems invalid for origin SpokePool
  DepositIdNotFound, // Deposit ID not found (bad RPC data?)
  FillMismatch, // Fill does not match deposit parameters for deposit ID.
  DepositIdOutOfRange, // Fill is for a deterministic deposit.
}

export type DepositSearchResult =
  | { found: true; deposit: DepositWithBlock }
  | { found: false; code: InvalidFill; reason: string };

/**
 * Attempts to resolve a deposit for a fill. If the fill's deposit Id is within the spoke pool client's search range,
 * the deposit is returned immediately. Otherwise, the deposit is queried first from the provided cache, and if it is
 * not found in the cache, it is queried from the spoke pool client. If the deposit is found, it is cached before
 * being returned.
 * @param spokePoolClient The spoke pool client to use to query the deposit.
 * @param fill The fill to resolve a deposit for.
 * @param cache An optional cache to use to store the deposit. Optional.
 * @returns The deposit for the fill, or undefined if the deposit could not be found.
 * @throws If the fill's origin chain ID does not match the spoke pool client's chain ID.
 * @throws If the spoke pool client has not been updated.
 */
// @todo relocate
export async function queryHistoricalDepositForFill(
  spokePoolClient: SpokePoolClient,
  fill: Fill | SlowFillRequest,
  cache?: CachingMechanismInterface
): Promise<DepositSearchResult> {
  if (isUnsafeDepositId(fill.depositId)) {
    return {
      found: false,
      code: InvalidFill.DepositIdOutOfRange,
      reason: `Cannot find historical deposit for fill with unsafe deposit ID ${fill.depositId}.`,
    };
  }
  if (fill.originChainId !== spokePoolClient.chainId) {
    throw new Error(`OriginChainId mismatch (${fill.originChainId} != ${spokePoolClient.chainId})`);
  }

  // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
  // as the global first and last deposit ID's for this spoke pool.
  if (!spokePoolClient.isUpdated) {
    throw new Error("SpokePoolClient must be updated before querying historical deposits");
  }

  const { depositId } = fill;
  const originChain = getNetworkName(fill.originChainId);
  let deposit = spokePoolClient.getDeposit(depositId);
  if (isDefined(deposit)) {
    const match = validateFillForDeposit(fill, deposit);
    if (match.valid) {
      return { found: true, deposit };
    }

    return {
      found: false,
      code: InvalidFill.FillMismatch,
      reason: `Fill for ${originChain} deposit ID ${depositId.toString()} is invalid (${match.reason}).`,
    };
  }

  // Deposit not found in SpokePoolClient buffer, search elsewhere.
  let cachedDeposit: Deposit | undefined;
  if (cache) {
    cachedDeposit = await getDepositInCache(getDepositKey(fill), cache);
    // We only want to warn and remove the cached deposit if it
    //    A: exists
    //    B: is not formed correctly
    if (isDefined(cachedDeposit) && !isDepositFormedCorrectly(cachedDeposit)) {
      spokePoolClient.logger.warn({
        at: "[SDK]:DepositUtils#queryHistoricalDepositForFill",
        message: "Cached deposit was not formed correctly, removing from cache",
        fill,
        cachedDeposit,
      });
      // By setting this value to undefined, we eventually have to pull
      // the deposit from our spoke pool client. Because this new deposit
      // is formed correctly, we will cache it below.
      cachedDeposit = undefined;
    }
  }

  if (isDefined(cachedDeposit)) {
    deposit = cachedDeposit as DepositWithBlock;
  } else {
    const result = await spokePoolClient.findDeposit(fill.depositId);
    if (!result.found) {
      return result;
    }

    ({ deposit } = result);
    if (cache) {
      await setDepositInCache(deposit, getCurrentTime(), cache, DEFAULT_CACHING_TTL);
    }
  }
  assert(isDefined(deposit), `Unexpectedly failed to locate ${originChain} deposit ${fill.depositId}`);

  deposit.messageHash ??= getMessageHash(deposit.message);

  const match = validateFillForDeposit(fill, deposit);
  if (match.valid) {
    return { found: true, deposit: deposit! };
  }

  return {
    found: false,
    code: InvalidFill.FillMismatch,
    reason: match.reason,
  };
}

/**
 * Concatenate all fields from a Deposit, Fill or SlowFillRequest into a single string.
 * This can be used to identify a bridge event in a mapping. This is used instead of the actual keccak256 hash
 * (getRelayDataHash()) for two reasons: performance and the fact that only Deposit includes the `message` field, which
 * is required to compute a complete RelayData hash.
 * note: This function should _not_ be used to query the SpokePool.fillStatuses mapping.
 */
export function getRelayEventKey(
  data: Omit<RelayData, "message"> & { messageHash: string; destinationChainId: number }
): string {
  return [
    data.depositor,
    data.recipient,
    data.exclusiveRelayer,
    data.inputToken,
    data.outputToken,
    data.inputAmount,
    data.outputAmount,
    data.originChainId,
    data.destinationChainId,
    data.depositId,
    data.fillDeadline,
    data.exclusivityDeadline,
    data.messageHash,
  ]
    .map(String)
    .join("-");
}

const RELAYDATA_KEYS = [
  "depositId",
  "originChainId",
  "destinationChainId",
  "depositor",
  "recipient",
  "inputToken",
  "inputAmount",
  "outputToken",
  "outputAmount",
  "fillDeadline",
  "exclusivityDeadline",
  "exclusiveRelayer",
  "messageHash",
] as const;

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as destinationToken, which are pulled from other clients.
export function validateFillForDeposit(
  relayData: Omit<RelayData, "message"> & { messageHash: string; destinationChainId: number },
  deposit?: Omit<Deposit, "quoteTimestamp" | "fromLiteChain" | "toLiteChain">
): { valid: true } | { valid: false; reason: string } {
  if (deposit === undefined) {
    return { valid: false, reason: "Deposit is undefined" };
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  let invalidKey = RELAYDATA_KEYS.find((key) => relayData[key].toString() !== deposit[key].toString());

  // There should be no paths for `messageHash` to be unset, but mask it off anyway.
  if (!isDefined(invalidKey) && [relayData.messageHash, deposit.messageHash].includes(UNDEFINED_MESSAGE_HASH)) {
    invalidKey = "messageHash";
  }

  return isDefined(invalidKey)
    ? { valid: false, reason: `${invalidKey} mismatch (${relayData[invalidKey]} != ${deposit[invalidKey]})` }
    : { valid: true };
}

/**
 * Returns true if filling this deposit (as a slow or fast fill) or refunding it would not change any state
 * on-chain. The dataworker functions can use this to conveniently filter out useless deposits.
 * @dev The reason we allow a 0-input deposit to have a non-empty message is that the message might be used
 * to pay the filler in an indirect way so it might have economic value as a fast or slow fill.
 * @param deposit Deposit to check.
 * @returns True if deposit's input amount is 0 and message is empty.
 */
export function isZeroValueDeposit(deposit: Pick<RelayData, "inputAmount" | "message">): boolean {
  return deposit.inputAmount.eq(0) && isMessageEmpty(deposit.message);
}

export function invalidOutputToken(deposit: Pick<RelayData, "outputToken">): boolean {
  // If the output token is zero address, then it is invalid.
  return deposit.outputToken.isZeroAddress();
}

export function isZeroValueFillOrSlowFillRequest(
  e: Pick<Fill | SlowFillRequest, "inputAmount" | "messageHash">
): boolean {
  return e.inputAmount.eq(bnZero) && e.messageHash === ZERO_BYTES;
}

/**
 * Determines if a message is empty or not.
 * @param message The message to check.
 * @returns True if the message is empty, false otherwise.
 */
export function isMessageEmpty(message = EMPTY_MESSAGE): boolean {
  return message === "" || message === "0x";
}

export function isFillOrSlowFillRequestMessageEmpty(message: string): boolean {
  return isMessageEmpty(message) || message === ZERO_BYTES;
}

/**
 * Determines if a deposit was updated via a speed-up transaction.
 * @param deposit Deposit to evaluate.
 * @returns True if the deposit was updated, otherwise false.
 */
export function isDepositSpedUp(deposit: Deposit): boolean {
  return isDefined(deposit.speedUpSignature) && isDefined(deposit.updatedOutputAmount);
}

/**
 * Resolves the applicable message for a deposit.
 * @param deposit Deposit to evaluate.
 * @returns Original or updated message string, depending on whether the depositor updated the deposit.
 */
export function resolveDepositMessage(deposit: Deposit): string {
  const message = isDepositSpedUp(deposit) ? deposit.updatedMessage : deposit.message;
  assert(isDefined(message)); // Appease tsc about the updatedMessage being possibly undefined.
  return message;
}

/**
 * Converts a RelayData object with `Address` types as address fields to a `RelayData`-like object with
 * strings as address fields.
 * @param relayData RelayData type.
 * @returns a RelayData-like type which has hex 32 byte strings as fields.
 */
export function convertRelayDataParamsToBytes32(relayData: RelayData): ConvertedRelayData {
  return {
    ...relayData,
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  };
}

/**
 * Converts a Fill object with `Address` types as address fields to a `RelayData`-like object with
 * strings as address fields.
 * @param relayData RelayData type.
 * @returns a RelayData-like type which has hex 32 byte strings as fields.
 */
export function convertFillParamsToBytes32(fill: Fill): ConvertedFill {
  return {
    ...fill,
    depositor: fill.depositor.toBytes32(),
    recipient: fill.recipient.toBytes32(),
    inputToken: fill.inputToken.toBytes32(),
    outputToken: fill.outputToken.toBytes32(),
    exclusiveRelayer: fill.exclusiveRelayer.toBytes32(),
    relayer: fill.relayer.toBytes32(),
    relayExecutionInfo: {
      ...fill.relayExecutionInfo,
      updatedRecipient: fill.relayExecutionInfo.updatedRecipient.toBytes32(),
    },
  };
}

/**
 * Converts a RelayData object with `Address` types as address fields to a `RelayData`-like object with
 * strings as address fields.
 * @param relayData RelayData type.
 * @returns a RelayData-like type which has native address representation strings as fields.
 */
export function convertRelayDataParamsToNative(relayData: RelayData): ConvertedRelayData {
  return {
    ...relayData,
    depositor: relayData.depositor.toNative(),
    recipient: relayData.recipient.toNative(),
    inputToken: relayData.inputToken.toNative(),
    outputToken: relayData.outputToken.toNative(),
    exclusiveRelayer: relayData.exclusiveRelayer.toNative(),
  };
}

/**
 * Converts a Fill object with `Address` types as address fields to a `RelayData`-like object with
 * strings as address fields.
 * @param relayData RelayData type.
 * @returns a RelayData-like type which has native address representation strings as fields.
 */
export function convertFillParamsToNative(fill: Fill): ConvertedFill {
  return {
    ...fill,
    depositor: fill.depositor.toNative(),
    recipient: fill.recipient.toNative(),
    inputToken: fill.inputToken.toNative(),
    outputToken: fill.outputToken.toNative(),
    exclusiveRelayer: fill.exclusiveRelayer.toNative(),
    relayer: fill.relayer.toNative(),
    relayExecutionInfo: {
      ...fill.relayExecutionInfo,
      updatedRecipient: fill.relayExecutionInfo.updatedRecipient.toNative(),
    },
  };
}
