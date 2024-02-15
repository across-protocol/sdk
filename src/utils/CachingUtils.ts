import { DEFAULT_CACHING_SAFE_LAG, DEFAULT_CACHING_TTL } from "../constants";
import { CachingMechanismInterface, Deposit, Fill, SlowFillRequest } from "../interfaces";
import { assert } from "./LogUtils";
import { composeRevivers, objectWithBigNumberReviver } from "./ReviverUtils";
import { getV3RelayHashFromEvent } from "./SpokeUtils";
import { getCurrentTime } from "./TimeUtils";
import { isDefined } from "./TypeGuards";
import { isV2Deposit, isV2Fill } from "./V3Utils";

export function shouldCache(eventTimestamp: number, latestTime: number, cachingMaxAge: number): boolean {
  assert(eventTimestamp.toString().length === 10, "eventTimestamp must be in seconds");
  assert(latestTime.toString().length === 10, "eventTimestamp must be in seconds");
  return latestTime - eventTimestamp >= cachingMaxAge;
}

/**
 * Calls the cache's get method and returns the result if it is defined, otherwise returns undefined.
 * @param key The key to get from the cache.
 * @param cache The cache to get the key from.
 * @returns The value associated with the key in the cache, or undefined if the key is not in the cache.
 */
export async function getDepositInCache(key: string, cache: CachingMechanismInterface): Promise<Deposit | undefined> {
  const depositRaw = await cache.get<string>(key);
  return isDefined(depositRaw) ? JSON.parse(depositRaw, composeRevivers(objectWithBigNumberReviver)) : undefined;
}

export async function setDepositInCache(
  deposit: Deposit,
  currentChainTime: number,
  cache: CachingMechanismInterface,
  expirySeconds = DEFAULT_CACHING_TTL,
  timeToCache = DEFAULT_CACHING_SAFE_LAG
): Promise<void> {
  const currentTimeInSeconds = getCurrentTime();
  // We should first confirm that neither the deposit's quoteTimestamp nor the currentChainTime
  // are in the future. If they are, we should not cache the deposit.
  if (deposit.quoteTimestamp > currentTimeInSeconds || currentChainTime > currentTimeInSeconds) {
    return;
  }

  // We should note here that the user can theoretically set the deposit's quoteTimestamp
  // to whatever they want. As a result, this could be used to manipulate the caching mechanism.
  if (shouldCache(deposit.quoteTimestamp, currentChainTime, timeToCache)) {
    await cache.set(getDepositKey(deposit), JSON.stringify(deposit), expirySeconds);
  }
}

/**
 * Resolves the key for caching a bridge event.
 * @param bridgeEvent The depositId, and originChainId are used to generate the key for v2, and the
 * full V3 relay hash is used for v3 events..
 * @returns The key for caching the event.
 */
export function getDepositKey(bridgeEvent: Deposit | Fill | SlowFillRequest): string {
  if (isV2Deposit(bridgeEvent as Deposit) || isV2Fill(bridgeEvent)) {
    return `deposit_${bridgeEvent.originChainId}_${bridgeEvent.depositId}`;
  } else {
    const relayHash = getV3RelayHashFromEvent(bridgeEvent);
    return `deposit_${bridgeEvent.originChainId}_${bridgeEvent.depositId}_${relayHash}`;
  }
}
