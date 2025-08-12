import {
  RpcTransport,
  GetTransactionApi,
  RpcFromTransport,
  SolanaRpcApiFromTransport,
  GetBlockTimeApi,
} from "@solana/kit";
import { getThrowSolanaErrorResponseTransformer } from "@solana/rpc-transformers";
import { is, number, object, optional, string, tuple } from "superstruct";
import { CachingMechanismInterface } from "../../interfaces";
import { SolanaClusterRpcFactory } from "./baseRpcFactories";
import { CacheType } from "../utils";
import { jsonReplacerWithBigInts, jsonReviverWithBigInts } from "../../utils";
import { RetrySolanaRpcFactory } from "./retryRpcFactory";
import { random } from "lodash";
import { BLOCK_NUMBER_TTL, PROVIDER_CACHE_TTL, PROVIDER_CACHE_TTL_MODIFIER as ttl_modifier } from "../constants";
import { assert } from "chai";

// A CachedFactory contains a RetryFactory and provides a caching layer that caches
// the results of the RetryFactory's RPC calls.
export class CachedSolanaRpcFactory extends SolanaClusterRpcFactory {
  public readonly getTransactionCachePrefix: string;
  public readonly getBlockTimeCachePrefix: string;
  baseTTL = PROVIDER_CACHE_TTL;

  // Holds the underlying transport that the cached transport wraps.
  protected retryTransport: RpcTransport;

  // RPC client based on the retry transport, used internally to check confirmation status.
  protected retryRpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;

  // Cached latest finalized slot and its publish timestamp.
  latestFinalizedSlot = Number.MAX_SAFE_INTEGER;
  publishTimestampLatestFinalizedSlot = 0;
  maxAgeLatestFinalizedSlot = 1000 * BLOCK_NUMBER_TTL;

  // Cached latest confirmed slot and its publish timestamp.
  latestConfirmedSlot = Number.MAX_SAFE_INTEGER;
  publishTimestampLatestConfirmedSlot = 0;
  maxAgeLatestConfirmedSlot = 1000 * BLOCK_NUMBER_TTL;

  constructor(
    providerCacheNamespace: string,
    readonly redisClient?: CachingMechanismInterface,
    ...retryConstructorParams: ConstructorParameters<typeof RetrySolanaRpcFactory>
  ) {
    // SolanaClusterRpcFactory shares the last two constructor parameters with RetryRpcFactory.
    const superParams = retryConstructorParams.slice(-2) as [
      ConstructorParameters<typeof SolanaClusterRpcFactory>[0], // clusterUrl: ClusterUrl
      ConstructorParameters<typeof SolanaClusterRpcFactory>[1], // chainId: number
    ];
    super(...superParams);

    // Create the rate limited transport and RPC client.
    const retryRpcFactory = new RetrySolanaRpcFactory(...retryConstructorParams);
    this.retryTransport = retryRpcFactory.createTransport();
    this.retryRpcClient = retryRpcFactory.createRpcClient();

    // Pre-compute as much of the redis key as possible.
    const cachePrefix = `${providerCacheNamespace},${new URL(this.clusterUrl).hostname},${this.chainId}`;
    this.getTransactionCachePrefix = `${cachePrefix}:getTransaction,`;
    this.getBlockTimeCachePrefix = `${cachePrefix}:getBlockTime,`;
  }

  public createTransport(): RpcTransport {
    return async <TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> => {
      const { method, params } = args[0].payload as { method: string; params?: unknown[] };
      if (!this.redisClient) {
        return this.retryTransport<TResponse>(...args);
      }

      let latestFinalizedSlot = 0;
      let latestConfirmedSlot = 0;
      if (method === "getBlockTime") {
      [latestFinalizedSlot, latestConfirmedSlot] = await Promise.all([
        this.getLatestFinalizedSlot(),
        this.getLatestConfirmedSlot(),
      ]);
    }

      const cacheType = this.cacheType(method, params ?? [], latestFinalizedSlot, latestConfirmedSlot);

      if (cacheType === CacheType.NONE) {
        return this.retryTransport<TResponse>(...args);
      }

      const redisKey = this.buildRedisKey(method, params);

      // Attempt to pull the result from the cache.
      const redisResult = await this.redisClient?.get<string>(redisKey);

      // If cache has the result, parse the json and return it.
      if (redisResult) {
        return JSON.parse(redisResult, jsonReviverWithBigInts);
      }

      // Cache does not have the result. Query it directly and cache it if finalized.
      return this.requestAndCacheFinalized<TResponse>(cacheType, ...args);
    };
  }

  private async getLatestFinalizedSlot(): Promise<number> {
    const fetchLatestFinalizedSlot = async () => {
      return await this.retryRpcClient.getSlot({ commitment: "finalized" }).send();
    };
    if (this.latestFinalizedSlot === Number.MAX_SAFE_INTEGER) {
      this.latestFinalizedSlot = Number(await fetchLatestFinalizedSlot());
      this.publishTimestampLatestFinalizedSlot = Date.now();
      return this.latestFinalizedSlot;
    }
    if (Date.now() - this.publishTimestampLatestFinalizedSlot > this.maxAgeLatestFinalizedSlot) {
      this.latestFinalizedSlot = Number(await fetchLatestFinalizedSlot());
      this.publishTimestampLatestFinalizedSlot = Date.now();
    }
    return this.latestFinalizedSlot;
  }

  private async getLatestConfirmedSlot(): Promise<number> {
    const fetchLatestConfirmedSlot = async () => {
      return await this.retryRpcClient.getSlot({ commitment: "confirmed" }).send();
    };
    if (this.latestConfirmedSlot === Number.MAX_SAFE_INTEGER) {
      this.latestConfirmedSlot = Number(await fetchLatestConfirmedSlot());
      this.publishTimestampLatestConfirmedSlot = Date.now();
      return this.latestConfirmedSlot;
    }
    if (Date.now() - this.publishTimestampLatestConfirmedSlot > this.maxAgeLatestConfirmedSlot) {
      this.latestConfirmedSlot = Number(await fetchLatestConfirmedSlot());
      this.publishTimestampLatestConfirmedSlot = Date.now();
    }
    return this.latestConfirmedSlot;
  }

  private async requestAndCacheFinalized<TResponse>(
    cacheType: CacheType,
    ...args: Parameters<RpcTransport>
  ): Promise<TResponse> {
    assert(
      cacheType === CacheType.NO_TTL || cacheType === CacheType.WITH_TTL,
      "requestAndCacheFinalized: Cache type must be NO_TTL or WITH_TTL"
    );
    const { method, params } = args[0].payload as { method: string; params?: unknown[] };

    if (method !== "getTransaction" && method !== "getBlockTime") return this.retryTransport<TResponse>(...args);

    // Do not throw if params are not valid, just skip caching and pass through to the underlying transport.
    switch (method) {
      case "getTransaction":
        if (!this.isGetTransactionParams(params)) return this.retryTransport<TResponse>(...args);
        // Check the confirmation status first to avoid caching non-finalized transactions. In case of null or errors just
        // skip caching and pass through to the underlying transport.
        try {
          const getSignatureStatusesResponse = await this.retryRpcClient
            .getSignatureStatuses([params[0]], {
              searchTransactionHistory: true,
            })
            .send();
          if (getSignatureStatusesResponse.value[0]?.confirmationStatus !== "finalized") {
            return this.retryTransport<TResponse>(...args);
          }
        } catch (error) {
          return this.retryTransport<TResponse>(...args);
        }
        break;
      case "getBlockTime":
        if (!this.isGetBlockTimeParams(params)) return this.retryTransport<TResponse>(...args);
        break;
    }

    const response = await this.retryTransport<TResponse>(...args);

    // Do not cache JSON-RPC error responses, let them pass through for the RPC client to handle.
    try {
      getThrowSolanaErrorResponseTransformer()(response, { methodName: method, params });
    } catch {
      return response;
    }

    // Cache the transaction JSON-RPC response as we checked the transaction is finalized and not an error.
    const redisKey = this.buildRedisKey(method, params);
    // Apply a random margin to spread expiry over a larger time window.
    const standardTtl = this.baseTTL + Math.ceil(random(-ttl_modifier, ttl_modifier, true) * this.baseTTL);
    const ttl = cacheType === CacheType.WITH_TTL ? standardTtl : Number.POSITIVE_INFINITY;
    await this.redisClient?.set(redisKey, JSON.stringify(response, jsonReplacerWithBigInts), ttl);

    return response;
  }

  private buildRedisKey(method: string, params?: unknown[]) {
    // Only handles getTransaction right now.
    switch (method) {
      case "getTransaction":
        return this.getTransactionCachePrefix + JSON.stringify(params, jsonReplacerWithBigInts);
      case "getBlockTime":
        return this.getBlockTimeCachePrefix + JSON.stringify(params, jsonReplacerWithBigInts);
      default:
        throw new Error(`CachedSolanaRpcFactory::buildRedisKey: invalid JSON-RPC method ${method}`);
    }
  }

  private cacheType(
    method: string,
    params: unknown[] = [],
    latestFinalizedSlot = 0,
    latestConfirmedSlot = 0
  ): CacheType {
    if (method === "getBlockTime") {
      const targetSlot = (params as Parameters<GetBlockTimeApi["getBlockTime"]>)[0];
      if (targetSlot <= latestFinalizedSlot) {
        return CacheType.NO_TTL;
      } else if (targetSlot > latestFinalizedSlot && targetSlot <= latestConfirmedSlot) {
        return CacheType.WITH_TTL;
      } else {
        return CacheType.NONE;
      }
    } else if (method === "getTransaction") {
      // We only store finalized transactions in the cache, hence TTL is not required.
      return CacheType.NO_TTL;
    } else {
      return CacheType.NONE;
    }
  }

  private isGetTransactionParams(params: unknown): params is Parameters<GetTransactionApi["getTransaction"]> {
    return is(
      params,
      tuple([
        string(), // Signature (Base58 string)
        optional(object()), // We use only the tx signature to get its commitment, but pass through the options as is.
      ])
    );
  }

  private isGetBlockTimeParams(params: unknown): params is Parameters<GetBlockTimeApi["getBlockTime"]> {
    return is(params, tuple([number()]));
  }
}
