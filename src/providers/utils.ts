// The async/queue library has a task-based interface for building a concurrent queue.
import assert from "assert";
import { providers } from "ethers";
import { isEqual, sortBy } from "lodash";
import { getOriginFromURL, isDefined } from "../utils";
import { JsonRpcError, RpcError, RPCProvider, RPCTransport } from "./types";
import * as alchemy from "./alchemy";
import * as infura from "./infura";
import * as drpc from "./drpc";
import * as quicknode from "./quicknode";

/**
 * Infura DIN is identified separately to allow it to be configured explicitly.
 */
const PROVIDERS = {
  ALCHEMY: alchemy.getURL,
  INFURA: infura.getURL,
  INFURA_DIN: infura.getURL,
  DRPC: drpc.getURL,
  QUICKNODE: quicknode.getURL,
};

/**
 * Type predicate for RPCProvider type.
 * @param provider Provider string (ALCHEMY, INFURA, ...).
 * @returns True if the provider string is a supported provider.
 */
export function isSupportedProvider(provider: string): provider is RPCProvider {
  return Object.keys(PROVIDERS).includes(provider);
}

/**
 * Produce an RPC for a given RPC provider, chainId API key and transport.
 * @param provider RPC provider identifier (ALCHEMY, INFURA, ...)
 * @param chainId Chain ID to obtain a URL for.
 * @param apiKey API key for provider.
 * @param transport Optional transport specifier (HTTPS or WSS).
 * @returns An RPC URL confirming to the specified inputs.
 */
export function getURL(
  provider: RPCProvider,
  chainId: number,
  apiKey: string,
  transport: RPCTransport = "https"
): string {
  const getURL = PROVIDERS[provider];
  assert(getURL, `Unsupported RPC provider (${provider})`);
  return getURL(chainId, apiKey, transport);
}

/**
 * Deletes keys from an object and returns new copy of object without ignored keys
 * @param ignoredKeys
 * @param obj
 * @returns Objects with ignored keys removed
 */
function deleteIgnoredKeys(ignoredKeys: string[], obj: Record<string, unknown>) {
  if (!isDefined(obj)) {
    return;
  }
  const newObj = { ...obj };
  for (const key of ignoredKeys) {
    delete newObj[key];
  }
  return newObj;
}

export function compareResultsAndFilterIgnoredKeys(
  ignoredKeys: string[],
  _objA: Record<string, unknown>,
  _objB: Record<string, unknown>
): boolean {
  // Remove ignored keys from copied objects.
  const filteredA = deleteIgnoredKeys(ignoredKeys, _objA);
  const filteredB = deleteIgnoredKeys(ignoredKeys, _objB);

  // Compare objects without the ignored keys.
  return isEqual(filteredA, filteredB);
}

export function compareArrayResultsWithIgnoredKeys(ignoredKeys: string[], objA: unknown[], objB: unknown[]): boolean {
  // Remove ignored keys from each element of copied arrays.
  const filteredA = objA?.map((obj) => deleteIgnoredKeys(ignoredKeys, obj as Record<string, unknown>));
  const filteredB = objB?.map((obj) => deleteIgnoredKeys(ignoredKeys, obj as Record<string, unknown>));

  // Compare objects without the ignored keys.
  const sortKeys = ["transactionIndex", "logIndex"];
  return (
    isDefined(filteredA) && isDefined(filteredB) && isEqual(sortBy(filteredA, sortKeys), sortBy(filteredB, sortKeys))
  );
}

/**
 * A record of error codes that correspond to fields that should be ignored when comparing RPC results.
 * This is used to compare results from different providers that may have different, but still valid, results.
 */
const IGNORED_FIELDS = {
  // We've seen some RPC's like QuickNode add in transactionLogIndex which isn't in the
  // JSON RPC spec: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getfilterchanges
  // Additional reference: https://github.com/ethers-io/ethers.js/issues/1721
  // 2023-08-31 Added blockHash because of upstream zkSync provider disagreements. Consider removing later.
  // 2024-05-07 Added l1BatchNumber and logType due to Alchemy. Consider removing later.
  // 2024-07-11 Added blockTimestamp after zkSync rolled out a new node release.
  // 2025-07-24 Added additional fields returned by Chainstack on (at least) Polygon.
  eth_getBlockByNumber: [
    "miner", // polygon (sometimes)
    "l1BatchNumber", // zkSync
    "l1BatchTimestamp", // zkSync
    "requestsHash", // Chainstack (Polygon)
    "size", // Alchemy/Arbitrum (temporary)
    "totalDifficulty", // Quicknode/Alchemy (sometimes)
    "logsBloom", // zkSync (third-party providers return 0x0..0)
    "transactions", // Polygon yParity field in transactions[]
    "withdrawals", // Chainstack (Polygon)
    "sendCount", // Arbitrum
    "sendRoot", // Arbitrum
  ],
  eth_getLogs: ["blockTimestamp", "transactionLogIndex", "l1BatchNumber", "logType"],
};

// Cap on entries reported per bucket in an eth_getLogs delta, to keep log payloads bounded
// when a provider returns thousands of stale or extra logs.
const LOG_DIFF_MAX_ENTRIES = 5;

export interface LogDiffEntry {
  key: string;
  entry?: Record<string, unknown>;
  fieldDiffs?: Record<string, { a: unknown; b: unknown }>;
}

export interface LogDiff {
  totalA: number;
  totalB: number;
  onlyInA: LogDiffEntry[];
  onlyInB: LogDiffEntry[];
  differing: LogDiffEntry[];
  truncated?: { onlyInA?: number; onlyInB?: number; differing?: number };
}

function fieldDiff(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): Record<string, { a: unknown; b: unknown }> {
  const diff: Record<string, { a: unknown; b: unknown }> = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    if (!isEqual(a?.[key], b?.[key])) {
      diff[key] = { a: a?.[key], b: b?.[key] };
    }
  }
  return diff;
}

function deepDiff(a: unknown, b: unknown): Record<string, { a: unknown; b: unknown }> {
  const out: Record<string, { a: unknown; b: unknown }> = {};
  const visit = (lhs: unknown, rhs: unknown, path: string) => {
    if (isEqual(lhs, rhs)) {
      return;
    }
    const lhsIsObj = isDefined(lhs) && typeof lhs === "object";
    const rhsIsObj = isDefined(rhs) && typeof rhs === "object";
    if (!lhsIsObj || !rhsIsObj || Array.isArray(lhs) !== Array.isArray(rhs)) {
      out[path || "."] = { a: lhs, b: rhs };
      return;
    }
    if (Array.isArray(lhs)) {
      const arrA = lhs as unknown[];
      const arrB = rhs as unknown[];
      const len = Math.max(arrA.length, arrB.length);
      for (let i = 0; i < len; i++) {
        visit(arrA[i], arrB[i], `${path}[${i}]`);
      }
      return;
    }
    const oa = lhs as Record<string, unknown>;
    const ob = rhs as Record<string, unknown>;
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
    for (const k of keys) {
      visit(oa[k], ob[k], path ? `${path}.${k}` : k);
    }
  };
  visit(a, b, "");
  return out;
}

function logKey(log: Record<string, unknown>): string {
  return `${(log?.transactionHash as string) ?? "?"}:${(log?.logIndex as string | number) ?? "?"}`;
}

function diffLogResults(
  ignoredKeys: string[],
  rpcResultA: unknown[] | undefined,
  rpcResultB: unknown[] | undefined
): LogDiff {
  const stripA = (rpcResultA ?? []).map(
    (entry) => (deleteIgnoredKeys(ignoredKeys, entry as Record<string, unknown>) ?? {}) as Record<string, unknown>
  );
  const stripB = (rpcResultB ?? []).map(
    (entry) => (deleteIgnoredKeys(ignoredKeys, entry as Record<string, unknown>) ?? {}) as Record<string, unknown>
  );
  const mapA = new Map(stripA.map((e) => [logKey(e), e]));
  const mapB = new Map(stripB.map((e) => [logKey(e), e]));

  const onlyInA: LogDiffEntry[] = [];
  const onlyInB: LogDiffEntry[] = [];
  const differing: LogDiffEntry[] = [];
  let droppedOnlyInA = 0;
  let droppedOnlyInB = 0;
  let droppedDiffering = 0;

  for (const [key, entry] of mapA) {
    const other = mapB.get(key);
    if (other === undefined) {
      if (onlyInA.length < LOG_DIFF_MAX_ENTRIES) {
        onlyInA.push({ key, entry });
      } else {
        droppedOnlyInA++;
      }
    } else if (!isEqual(entry, other)) {
      if (differing.length < LOG_DIFF_MAX_ENTRIES) {
        differing.push({ key, fieldDiffs: fieldDiff(entry, other) });
      } else {
        droppedDiffering++;
      }
    }
  }
  for (const [key, entry] of mapB) {
    if (!mapA.has(key)) {
      if (onlyInB.length < LOG_DIFF_MAX_ENTRIES) {
        onlyInB.push({ key, entry });
      } else {
        droppedOnlyInB++;
      }
    }
  }

  const truncated: NonNullable<LogDiff["truncated"]> = {};
  if (droppedOnlyInA) {
    truncated.onlyInA = droppedOnlyInA;
  }
  if (droppedOnlyInB) {
    truncated.onlyInB = droppedOnlyInB;
  }
  if (droppedDiffering) {
    truncated.differing = droppedDiffering;
  }

  return {
    totalA: stripA.length,
    totalB: stripB.length,
    onlyInA,
    onlyInB,
    differing,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
}

/**
 * Compact, JSON-safe diff between two RPC results for the same method. Strips the same fields
 * `compareRpcResults` strips, so the diff only reflects mismatches that actually mattered to
 * quorum. Intended for use after `compareRpcResults` has already determined the results disagree.
 *
 * - `eth_getLogs`: returns a `LogDiff` (per-log onlyInA / onlyInB / differing, capped at 5 entries
 *   per bucket with a truncation counter).
 * - `eth_getBlockByNumber`: returns a `{ key: { a, b }, ... }` map for non-ignored field diffs.
 * - any other method: returns a path-keyed deep diff (e.g. `"receipt.logs[0].data": { a, b }`).
 */
export function diffRpcResults(method: string, rpcResultA: unknown, rpcResultB: unknown): unknown {
  if (method === "eth_getLogs") {
    return diffLogResults(
      IGNORED_FIELDS.eth_getLogs,
      rpcResultA as unknown[] | undefined,
      rpcResultB as unknown[] | undefined
    );
  }
  if (method === "eth_getBlockByNumber") {
    const a = deleteIgnoredKeys(IGNORED_FIELDS.eth_getBlockByNumber, rpcResultA as Record<string, unknown>);
    const b = deleteIgnoredKeys(IGNORED_FIELDS.eth_getBlockByNumber, rpcResultB as Record<string, unknown>);
    return fieldDiff(a, b);
  }
  return deepDiff(rpcResultA, rpcResultB);
}

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
  return `Provider ${getOriginFromURL(provider.connection.url)} failed with error: ${rawErrorText}`;
}

// `{ cause }` keeps the wrapper an actual Error (was a spread-collapsed plain object) and keeps
// the underlying rejection reason reachable for callers and loggers.
export function createSendErrorWithMessage(message: string, sendError: unknown): Error {
  return new Error(message, { cause: sendError });
}

/**
 * Validate and parse a possible JSON-RPC error response.
 * @param error An unknown error object received in response to a JSON-RPC request.
 * @returns A JSON-RPC error object, or undefined.
 */
export function parseJsonRpcError(response: unknown): { code: number; message: string; data?: unknown } | undefined {
  if (!RpcError.is(response)) {
    return;
  }

  try {
    const error = JSON.parse(response.body);
    if (JsonRpcError.is(error)) {
      return error.error;
    }
  } catch {
    // Suppress error.
  }

  return;
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
      IGNORED_FIELDS.eth_getBlockByNumber,
      rpcResultA as Record<string, unknown>,
      rpcResultB as Record<string, unknown>
    );
  } else if (method === "eth_getLogs") {
    return compareArrayResultsWithIgnoredKeys(
      IGNORED_FIELDS.eth_getLogs,
      rpcResultA as unknown[],
      rpcResultB as unknown[]
    );
  } else {
    return isEqual(rpcResultA, rpcResultB);
  }
}

export function compareSvmRpcResults(_method: string, rpcResultA: unknown, rpcResultB: unknown): boolean {
  return isEqual(rpcResultA, rpcResultB);
}

export enum CacheType {
  NONE, // Do not cache
  WITH_TTL, // Cache with TTL
  NO_TTL, // Cache with infinite TTL
  DECIDE_TTL_POST_SEND, // Decide which TTL to cache with after we receive the RPC response
}
