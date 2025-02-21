import { random } from "lodash";
import { CachingMechanismInterface } from "../interfaces";
import { BLOCK_NUMBER_TTL, PROVIDER_CACHE_TTL, PROVIDER_CACHE_TTL_MODIFIER as ttl_modifier } from "./constants";
import { RateLimitedProvider } from "./rateLimitedProvider";
import { CacheType } from "./utils";

export class CacheProvider extends RateLimitedProvider {
  public readonly cachePrefix: string;
  public readonly baseTTL: number;

  constructor(
    providerCacheNamespace: string,
    readonly redisClient?: CachingMechanismInterface,
    // Note: if not provided, this is set to POSITIVE_INFINITY, meaning no cache entries are set with the standard TTL.
    readonly standardTtlBlockDistance = Number.POSITIVE_INFINITY,
    // Note: if not provided, this is set to POSITIVE_INFINITY, meaning no cache entries are set with no TTL.
    readonly noTtlBlockDistance = Number.POSITIVE_INFINITY,
    readonly providerCacheTtl = PROVIDER_CACHE_TTL,
    ...jsonRpcConstructorParams: ConstructorParameters<typeof RateLimitedProvider>
  ) {
    super(...jsonRpcConstructorParams);

    const { chainId } = this.network;

    this.cachePrefix = `${providerCacheNamespace},${new URL(this.connection.url).hostname},${chainId}`;

    const _ttlVar = providerCacheTtl;
    const _ttl = Number(_ttlVar);
    if (isNaN(_ttl) || _ttl <= 0) {
      throw new Error(`PROVIDER_CACHE_TTL (${_ttlVar}) must be numeric and > 0`);
    }
    this.baseTTL = _ttl;
  }
  override async send(method: string, params: Array<unknown>): Promise<unknown> {
    const preRequestCacheType = this.redisClient ? await this.cacheType(method, params) : CacheType.NONE;

    if (preRequestCacheType !== CacheType.NONE) {
      const redisKey = this.buildRedisKey(method, params);

      // Attempt to pull the result from the cache.
      const redisResult = await this.redisClient?.get<string>(redisKey);

      // If cache has the result, parse the json and return it.
      if (redisResult) {
        return JSON.parse(redisResult);
      }

      // Cache does not have the result. Query it directly and cache.
      const result = await super.send(method, params);

      let postRequestCacheType: CacheType = preRequestCacheType;
      if (preRequestCacheType === CacheType.DECIDE_TTL_POST_SEND) {
        const blockNumber = this.getBlockNumberFromRpcResponse(method, result);
        postRequestCacheType = await this.cacheTypeForBlock(blockNumber);
      }

      // Note: use swtich to ensure all enum cases are handled.
      switch (postRequestCacheType) {
        case CacheType.WITH_TTL:
          {
            // Apply a random margin to spread expiry over a larger time window.
            const ttl = this.baseTTL + Math.ceil(random(-ttl_modifier, ttl_modifier, true) * this.baseTTL);
            await this.redisClient?.set(redisKey, JSON.stringify(result), ttl);
          }
          break;
        case CacheType.NO_TTL:
          await this.redisClient?.set(redisKey, JSON.stringify(result), Number.POSITIVE_INFINITY);
          break;
        default:
          throw new Error(`Unexpected Cache type: ${postRequestCacheType}`);
      }

      // Return the cached result.
      return result;
    }

    return await super.send(method, params);
  }

  private buildRedisKey(method: string, params: Array<unknown>) {
    switch (method) {
      case "eth_getBlockByNumber":
        return `${this.cachePrefix}:getBlockByNumber,` + JSON.stringify(params);
      default:
        return `${this.cachePrefix}:${method},` + JSON.stringify(params);
    }
  }

  private cacheType(method: string, params: Array<unknown>): Promise<CacheType> {
    // Today, we only cache eth_getLogs and eth_call.
    if (method === "eth_getLogs") {
      const [{ fromBlock, toBlock }] = params as { toBlock: number; fromBlock: number }[];

      // Handle odd cases where the ordering is flipped, etc.
      // toBlock/fromBlock is in hex, so it must be parsed before being compared to the first unsafe block.
      const fromBlockNumber = parseInt(String(fromBlock), 16);
      const toBlockNumber = parseInt(String(toBlock), 16);

      // Handle cases where the input block numbers are not hex values ("latest", "pending", etc).
      // This would result in the result of the above being NaN.
      if (Number.isNaN(fromBlockNumber) || Number.isNaN(toBlockNumber)) {
        return Promise.resolve(CacheType.NONE);
      }

      if (toBlockNumber < fromBlockNumber) {
        throw new Error("CacheProvider::shouldCache toBlock cannot be smaller than fromBlock.");
      }

      return this.cacheTypeForBlock(toBlock);
    } else if ("eth_call" === method || "eth_getBlockByNumber" === method) {
      // Pull out the block tag from params. Its position in params is dependent on the method.
      // We are only interested in numeric block tags, which would be hex-encoded strings.
      const idx = method === "eth_getBlockByNumber" ? 0 : 1;
      const blockNumber = parseInt(String(params[idx]), 16);

      // If the block number isn't present or is a text string, this will be NaN and we return false.
      if (Number.isNaN(blockNumber)) {
        return Promise.resolve(CacheType.NONE);
      }

      // If the block is old enough to cache, cache the call.
      return this.cacheTypeForBlock(blockNumber);
    } else if ("eth_getTransactionReceipt" === method) {
      // The only param to this request is "hash" so we can't determine how old the data we want is until after
      // we receive the RPC result. Therefore we'll defer the TTL decision.
      return Promise.resolve(CacheType.DECIDE_TTL_POST_SEND);
    } else {
      return Promise.resolve(CacheType.NONE);
    }
  }

  private getBlockNumberFromRpcResponse(method: string, result: unknown): number {
    if (method === "eth_getTransactionReceipt") {
      const receipt = result as { blockNumber: number | string };
      return Number(receipt.blockNumber);
    } else {
      throw new Error(`CacheProvider::getBlockNumberFromRpcResponse: unsupported JSON-RPC method ${method}`);
    }
  }

  private async cacheTypeForBlock(blockNumber: number): Promise<CacheType> {
    // Note: this method is an internal method provided by the BaseProvider. It allows the caller to specify a maxAge of
    // the block that is allowed. This means if a block has been retrieved within the last n seconds, no provider
    // query will be made.
    const currentBlockNumber = await super._getInternalBlockNumber(BLOCK_NUMBER_TTL * 1000);

    // Determine the distance that the block is from HEAD.
    const headDistance = currentBlockNumber - blockNumber;

    // If the distance from head is large enough, set with no TTL.
    if (headDistance > this.noTtlBlockDistance) {
      return CacheType.NO_TTL;
    }

    // If the distance is <= noTtlBlockDistance, but > standardTtlBlockDistance, use standard TTL.
    if (headDistance > this.standardTtlBlockDistance) {
      return CacheType.WITH_TTL;
    }

    // Too close to HEAD, no cache.
    return CacheType.NONE;
  }
}
