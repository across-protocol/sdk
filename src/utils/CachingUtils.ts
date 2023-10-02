import { DEFAULT_CACHING_SAFE_LAG, DEFAULT_CACHING_TTL } from "../constants";
import { CachingMechanismInterface, Deposit, Fill } from "../interfaces";
import { assert } from "./LogUtils";
import { composeRevivers, objectWithBigNumberReviver } from "./ReviverUtils";
import { isDefined } from "./TypeGuards";

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
  expirySeconds = DEFAULT_CACHING_TTL
): Promise<void> {
  if (shouldCache(deposit.quoteTimestamp, currentChainTime, DEFAULT_CACHING_SAFE_LAG)) {
    await cache.set(getDepositKey(deposit), JSON.stringify(deposit), expirySeconds);
  }
}

/**
 * Resolves the key for caching either a deposit or a fill.
 * @param depositOrFill Either a deposit or a fill. In either case, the depositId and originChainId are used to generate the key.
 * @returns The key for caching the deposit or fill.
 */
export function getDepositKey(depositOrFill: Deposit | Fill): string {
  return `deposit_${depositOrFill.originChainId}_${depositOrFill.depositId}`;
}
