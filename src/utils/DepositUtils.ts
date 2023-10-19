import assert from "assert";
import { SpokePoolClient } from "../clients";
import { DEFAULT_CACHING_TTL, EMPTY_MESSAGE } from "../constants";
import { CachingMechanismInterface, Deposit, DepositWithBlock, Fill } from "../interfaces";
import { getDepositInCache, getDepositKey, setDepositInCache } from "./CachingUtils";
import { validateFillForDeposit } from "./FlowUtils";
import { getCurrentTime } from "./TimeUtils";
import { isDefined } from "./TypeGuards";
import { isDepositFormedCorrectly } from "./ValidatorUtils";

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.

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
  fill: Fill,
  cache?: CachingMechanismInterface
): Promise<DepositWithBlock | undefined> {
  if (fill.originChainId !== spokePoolClient.chainId) {
    throw new Error(`OriginChainId mismatch (${fill.originChainId} != ${spokePoolClient.chainId})`);
  }

  // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
  // as the global first and last deposit ID's for this spoke pool.
  if (!spokePoolClient.isUpdated) {
    throw new Error("SpokePoolClient must be updated before querying historical deposits");
  }

  if (
    fill.depositId < spokePoolClient.firstDepositIdForSpokePool ||
    fill.depositId > spokePoolClient.lastDepositIdForSpokePool
  ) {
    return undefined;
  }

  if (
    fill.depositId >= spokePoolClient.earliestDepositIdQueried &&
    fill.depositId <= spokePoolClient.latestDepositIdQueried
  ) {
    return spokePoolClient.getDepositForFill(fill);
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
    deposit = await spokePoolClient.findDeposit(fill.depositId, fill.destinationChainId, fill.depositor);
    if (cache) {
      await setDepositInCache(deposit, getCurrentTime(), cache, DEFAULT_CACHING_TTL);
    }
  }

  return validateFillForDeposit(fill, deposit) ? deposit : undefined;
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
  return isDefined(deposit.speedUpSignature) && isDefined(deposit.newRelayerFeePct);
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
