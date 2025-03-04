import { RpcTransport, GetTransactionApi, RpcFromTransport, SolanaRpcApiFromTransport } from "@solana/web3.js";
import { is, object, optional, string, tuple } from "superstruct";
import { CachingMechanismInterface } from "../../interfaces";
import { SolanaClusterRpcFactory } from "./baseRpcFactories";
import { RateLimitedSolanaRpcFactory } from "./rateLimitedRpcFactory";
import { CacheType } from "../utils";
import { jsonReplacerWithBigInts, jsonReviverWithBigInts } from "../../utils";

export class CachedSolanaRpcFactory extends SolanaClusterRpcFactory {
  public readonly getTransactionCachePrefix: string;

  // Holds the underlying transport that the cached transport wraps.
  protected rateLimitedTransport: RpcTransport;

  // RPC client based on the rate limited transport, used internally to check confirmation status.
  protected rateLimitedRpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;

  constructor(
    providerCacheNamespace: string,
    readonly redisClient?: CachingMechanismInterface,
    ...rateLimitedConstructorParams: ConstructorParameters<typeof RateLimitedSolanaRpcFactory>
  ) {
    // SolanaClusterRpcFactory shares the last two constructor parameters with RateLimitedSolanaRpcFactory.
    const superParams = rateLimitedConstructorParams.slice(-2) as [
      ConstructorParameters<typeof SolanaClusterRpcFactory>[0], // clusterUrl: ClusterUrl
      ConstructorParameters<typeof SolanaClusterRpcFactory>[1], // chainId: number
    ];
    super(...superParams);

    // Create the rate limited transport and RPC client.
    const rateLimitedRpcFactory = new RateLimitedSolanaRpcFactory(...rateLimitedConstructorParams);
    this.rateLimitedTransport = rateLimitedRpcFactory.createTransport();
    this.rateLimitedRpcClient = rateLimitedRpcFactory.createRpcClient();

    // Pre-compute as much of the redis key as possible.
    const cachePrefix = `${providerCacheNamespace},${new URL(this.clusterUrl).hostname},${this.chainId}`;
    this.getTransactionCachePrefix = `${cachePrefix}:getTransaction,`;
  }

  public createTransport(): RpcTransport {
    return async <TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> => {
      const { method, params } = args[0].payload as { method: string; params?: unknown[] };
      const cacheType = this.redisClient ? this.cacheType(method) : CacheType.NONE;

      if (cacheType === CacheType.NONE) {
        return this.rateLimitedTransport<TResponse>(...args);
      }
       
      const redisKey = this.buildRedisKey(method, params);

      // Attempt to pull the result from the cache.
      const redisResult = await this.redisClient?.get<string>(redisKey);

      // If cache has the result, parse the json and return it.
      if (redisResult) {
        return JSON.parse(redisResult, jsonReviverWithBigInts);
      }

      // Cache does not have the result. Query it directly and cache it if finalized.
      return this.requestAndCacheFinalized<TResponse>(...args);
    };
  }

  private async requestAndCacheFinalized<TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> {
    const { method, params } = args[0].payload as { method: string; params?: unknown[] };

    // Only handles getTransaction right now.
    if (method === "getTransaction") {
      // Do not throw if params are not valid, just skip caching and pass through to the underlying transport.
      if (!this.isGetTransactionParams(params)) return this.rateLimitedTransport<TResponse>(...args);

      // Check the confirmation status first to avoid caching non-finalized transactions.
      const getSignatureStatusesResponse = await this.rateLimitedRpcClient
        .getSignatureStatuses([params[0]], {
          searchTransactionHistory: true,
        })
        .send();

      const getTransactionResponse = await this.rateLimitedTransport<TResponse>(...args);

      // Cache the transaction only if it is finalized.
      if (getSignatureStatusesResponse.value[0]?.confirmationStatus === "finalized") {
        const redisKey = this.buildRedisKey(method, params);
        await this.redisClient?.set(
          redisKey,
          JSON.stringify(getTransactionResponse, jsonReplacerWithBigInts),
          Number.POSITIVE_INFINITY
        );
      }

      return getTransactionResponse;
    } else {
      return this.rateLimitedTransport<TResponse>(...args);
    }
  }

  private buildRedisKey(method: string, params?: unknown[]) {
    // Only handles getTransaction right now.
    switch (method) {
      case "getTransaction":
        return this.getTransactionCachePrefix + JSON.stringify(params, jsonReplacerWithBigInts);
      default:
        throw new Error(`CachedSolanaRpcFactory::buildRedisKey: invalid JSON-RPC method ${method}`);
    }
  }

  private cacheType(method: string): CacheType {
    // Today, we only cache getTransaction.
    if (method === "getTransaction") {
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
}
