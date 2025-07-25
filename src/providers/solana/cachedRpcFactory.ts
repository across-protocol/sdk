import { RpcTransport, GetTransactionApi, RpcFromTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import { getThrowSolanaErrorResponseTransformer } from "@solana/rpc-transformers";
import { is, object, optional, string, tuple } from "superstruct";
import { CachingMechanismInterface } from "../../interfaces";
import { SolanaClusterRpcFactory } from "./baseRpcFactories";
import { CacheType } from "../utils";
import { jsonReplacerWithBigInts, jsonReviverWithBigInts } from "../../utils";
import { RetrySolanaRpcFactory } from "./retryRpcFactory";

export class CachedSolanaRpcFactory extends SolanaClusterRpcFactory {
  public readonly getTransactionCachePrefix: string;

  // Holds the underlying transport that the cached transport wraps.
  protected retryTransport: RpcTransport;

  // RPC client based on the retry transport, used internally to check confirmation status.
  protected retryRpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;

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
  }

  public createTransport(): RpcTransport {
    return async <TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> => {
      const { method, params } = args[0].payload as { method: string; params?: unknown[] };
      const cacheType = this.redisClient ? this.cacheType(method) : CacheType.NONE;

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
      return this.requestAndCacheFinalized<TResponse>(...args);
    };
  }

  private async requestAndCacheFinalized<TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> {
    const { method, params } = args[0].payload as { method: string; params?: unknown[] };

    // Only handles getTransaction right now.
    if (method !== "getTransaction") return this.retryTransport<TResponse>(...args);

    // Do not throw if params are not valid, just skip caching and pass through to the underlying transport.
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

    const getTransactionResponse = await this.retryTransport<TResponse>(...args);

    // Do not cache JSON-RPC error responses, let them pass through for the RPC client to handle.
    try {
      getThrowSolanaErrorResponseTransformer()(getTransactionResponse, { methodName: method, params });
    } catch {
      return getTransactionResponse;
    }

    // Cache the transaction JSON-RPC response as we checked the transaction is finalized and not an error.
    const redisKey = this.buildRedisKey(method, params);
    await this.redisClient?.set(
      redisKey,
      JSON.stringify(getTransactionResponse, jsonReplacerWithBigInts),
      Number.POSITIVE_INFINITY
    );

    return getTransactionResponse;
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
