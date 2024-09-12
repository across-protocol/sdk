import { ethers } from "ethers";
import { CachingMechanismInterface } from "../interfaces";
import { CacheProvider } from "./cachedProvider";
import { formatProviderError } from "./utils";
import { PROVIDER_CACHE_TTL } from "./constants";
import { Logger } from "winston";

/**
 * RPC provider that sends requests to multiple providers in parallel and returns the fastest response.
 */
export class SpeedProvider extends ethers.providers.StaticJsonRpcProvider {
  readonly providers: ethers.providers.StaticJsonRpcProvider[];

  constructor(
    params: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>[],
    chainId: number,
    readonly maxConcurrencySpeed: number,
    readonly maxConcurrencyRateLimit: number,
    providerCacheNamespace: string,
    pctRpcCallsLogged: number,
    redisClient?: CachingMechanismInterface,
    standardTtlBlockDistance?: number,
    noTtlBlockDistance?: number,
    providerCacheTtl = PROVIDER_CACHE_TTL,
    logger?: Logger
  ) {
    // Initialize the super just with the chainId, which stops it from trying to immediately send out a .send before
    // this derived class is initialized.
    super(undefined, chainId);
    this.providers = params.map(
      (inputs) =>
        new CacheProvider(
          providerCacheNamespace,
          redisClient,
          standardTtlBlockDistance,
          noTtlBlockDistance,
          providerCacheTtl,
          maxConcurrencyRateLimit,
          pctRpcCallsLogged,
          logger,
          ...inputs
        )
    );
  }

  override async send(method: string, params: Array<unknown>): Promise<unknown> {
    try {
      const providersToUse = this.providers.slice(0, this.maxConcurrencySpeed);
      const result = await Promise.any(providersToUse.map((provider) => provider.send(method, params)));
      return result;
    } catch (error) {
      // Only thrown if all providers failed to respond
      if (error instanceof AggregateError) {
        const errors = error.errors.map((error, index) => {
          const provider = this.providers[index];
          return formatProviderError(provider, error.message);
        });
        throw new Error("All providers errored:\n" + errors.join("\n"));
      }
      throw error;
    }
  }
}
