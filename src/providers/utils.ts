// The async/queue library has a task-based interface for building a concurrent queue.

import { providers } from "ethers";
import lodash from "lodash";
import { compareArrayResultsWithIgnoredKeys, compareResultsAndFilterIgnoredKeys } from "../utils/ObjectUtils";

export { lodash };

/**
 * A record of error codes that correspond to fields that should be ignored when comparing RPC results.
 * This is used to compare results from different providers that may have different, but still valid, results.
 */
const IGNORED_ERROR_CODES = {
  // We've seen some RPC's like QuickNode add in transactionLogIndex which isn't in the
  // JSON RPC spec: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getfilterchanges
  // Additional reference: https://github.com/ethers-io/ethers.js/issues/1721
  // 2023-08-31 Added blockHash because of upstream zkSync provider disagreements. Consider removing later.
  // 2024-05-07 Added l1BatchNumber and logType due to Alchemy. Consider removing later.
  // 2024-07-11 Added blockTimestamp after zkSync rolled out a new node release.
  eth_getBlockByNumber: [
    "miner", // polygon (sometimes)
    "l1BatchNumber", // zkSync
    "l1BatchTimestamp", // zkSync
    "size", // Alchemy/Arbitrum (temporary)
    "totalDifficulty", // Quicknode/Alchemy (sometimes)
  ],
  eth_getLogs: ["blockTimestamp", "transactionLogIndex", "l1BatchNumber", "logType"],
};

/**
 * This is the type we pass to define a request "task".
 */
export interface RateLimitTask {
  // These are the arguments to be passed to super.send().
  sendArgs: [string, Array<unknown>];

  // These are the promise callbacks that will cause the initial send call made by the user to either return a result
  // or fail.
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * A helper function to format an error message for a provider.
 * @param provider The provider that failed.
 * @param rawErrorText The raw error text.
 * @returns The formatted error message.
 */
export function formatProviderError(provider: providers.StaticJsonRpcProvider, rawErrorText: string) {
  return `Provider ${provider.connection.url} failed with error: ${rawErrorText}`;
}

export function createSendErrorWithMessage(message: string, sendError: Record<string, unknown>) {
  const error = new Error(message);
  return { ...sendError, ...error };
}

/**
 * Compares two RPC results, filtering out fields that are known to differ between providers.
 * Note: this function references `IGNORED_ERROR_CODES` which is a record of error codes that correspond to fields
 *       that should be ignored when comparing RPC results.
 * @param method The method that was called - conditionally filters out fields based on the method.
 * @param rpcResultA The first RPC result.
 * @param rpcResultB The second RPC result.
 * @returns True if the results are equal, false otherwise.
 */
export function compareRpcResults(method: string, rpcResultA: unknown, rpcResultB: unknown): boolean {
  if (method === "eth_getBlockByNumber") {
    // We've seen RPC's disagree on the miner field, for example when Polygon nodes updated software that
    // led alchemy and quicknode to disagree on the miner field's value.
    return compareResultsAndFilterIgnoredKeys(
      IGNORED_ERROR_CODES.eth_getBlockByNumber,
      rpcResultA as Record<string, unknown>,
      rpcResultB as Record<string, unknown>
    );
  } else if (method === "eth_getLogs") {
    return compareArrayResultsWithIgnoredKeys(
      IGNORED_ERROR_CODES.eth_getLogs,
      rpcResultA as unknown[],
      rpcResultB as unknown[]
    );
  } else {
    return lodash.isEqual(rpcResultA, rpcResultB);
  }
}

export enum CacheType {
  NONE, // Do not cache
  WITH_TTL, // Cache with TTL
  NO_TTL, // Cache with infinite TTL
}
