import assert from "assert";
import { SpokePoolClient } from "../clients";
import { DEFAULT_CACHING_TTL, EMPTY_MESSAGE } from "../constants";
import { CachingMechanismInterface, Deposit, DepositWithBlock, Fill, SlowFillRequest } from "../interfaces";
import { getNetworkName } from "./NetworkUtils";
import { getDepositInCache, getDepositKey, setDepositInCache } from "./CachingUtils";
import { validateFillForDeposit } from "./FlowUtils";
import { getCurrentTime } from "./TimeUtils";
import { isDefined } from "./TypeGuards";
import { isDepositFormedCorrectly } from "./ValidatorUtils";
import { isV2Deposit, isV2Fill, isV3Deposit } from "./V3Utils";

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.

export enum InvalidFill {
  DepositIdInvalid = 0, // Deposit ID seems invalid for origin SpokePool
  DepositIdNotFound, // Deposit ID not found (bad RPC data?)
  FillMismatch, // Fill does not match deposit parameters for deposit ID.
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
export async function queryHistoricalDepositForFill(
  spokePoolClient: SpokePoolClient,
  fill: Fill | SlowFillRequest,
  cache?: CachingMechanismInterface
): Promise<DepositSearchResult> {
  if (fill.originChainId !== spokePoolClient.chainId) {
    throw new Error(`OriginChainId mismatch (${fill.originChainId} != ${spokePoolClient.chainId})`);
  }

  // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
  // as the global first and last deposit ID's for this spoke pool.
  if (!spokePoolClient.isUpdated) {
    throw new Error("SpokePoolClient must be updated before querying historical deposits");
  }

  const { depositId } = fill;
  let { firstDepositIdForSpokePool: lowId, lastDepositIdForSpokePool: highId } = spokePoolClient;
  if (depositId < lowId || depositId > highId) {
    return {
      found: false,
      code: InvalidFill.DepositIdInvalid,
      reason: `Deposit ID ${depositId} is outside of SpokePool bounds [${lowId},${highId}].`,
    };
  }

  ({ earliestDepositIdQueried: lowId, latestDepositIdQueried: highId } = spokePoolClient);
  if (depositId >= lowId && depositId <= highId) {
    const deposit = spokePoolClient.getDeposit(depositId);
    if (isDefined(deposit) && validateFillForDeposit(fill, deposit)) {
      return { found: true, deposit };
    }

    return {
      found: false,
      code: isDefined(deposit) ? InvalidFill.FillMismatch : InvalidFill.DepositIdNotFound,
      reason: `Deposit ID ${depositId} not found in SpokePoolClient event buffer.`,
    };
  }

  let deposit: DepositWithBlock, cachedDeposit: Deposit | undefined;
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
    if (isV2Fill(fill)) {
      deposit = await spokePoolClient.findDeposit(fill.depositId, fill.destinationChainId, fill.depositor);
    } else {
      deposit = await spokePoolClient.findDepositV3(fill.depositId, fill.destinationChainId, fill.depositor);
    }
    if (cache) {
      await setDepositInCache(deposit, getCurrentTime(), cache, DEFAULT_CACHING_TTL);
    }
  }

  if (validateFillForDeposit(fill, deposit)) {
    return { found: true, deposit };
  }

  return {
    found: false,
    code: InvalidFill.FillMismatch,
    reason: `Fill is not valid for ${getNetworkName(deposit.originChainId)} deposit ${depositId}`,
  };
}

/**
 * Determines if a message is empty or not.
 * @param message The message to check.
 * @returns True if the message is empty, false otherwise.
 */
export function isMessageEmpty(message = EMPTY_MESSAGE): boolean {
  return message === "" || message === "0x";
}

/**
 * Determines if a deposit was updated via a speed-up transaction.
 * @param deposit Deposit to evaluate.
 * @returns True if the deposit was updated, otherwise false.
 */
export function isDepositSpedUp(deposit: Deposit): boolean {
  // prettier-ignore
  return (
    isDefined(deposit.speedUpSignature) &&
    (
      (isV2Deposit(deposit) && isDefined(deposit.newRelayerFeePct)) ||
      (isV3Deposit(deposit) && isDefined(deposit.updatedOutputAmount))
    )
  );
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
