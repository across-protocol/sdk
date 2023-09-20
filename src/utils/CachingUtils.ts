import { assert } from "./LogUtils";

export function shouldCache(eventTimestamp: number, latestTime: number, cachingMaxAge: number): boolean {
  assert(eventTimestamp.toString().length === 10, "eventTimestamp must be in seconds");
  assert(latestTime.toString().length === 10, "eventTimestamp must be in seconds");
  return latestTime - eventTimestamp >= cachingMaxAge;
}
