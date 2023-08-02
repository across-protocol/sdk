/**
 * Defines the configuration to customize a UBAClient instance.
 */
class UBAClientConfig {
  /**
   * Instantiate a new UBAClient Config object
   * @param latestMainnetBundleStartBlockToLoadFromCache If defined, the UBAClient will only load bundle data from
   * the cache from bundles whose mainnet start block is greater than or equal to this value. All older bundles
   * will be loaded from the cache and all newer bundles will be loaded fresh from new RPC data.
   */
  constructor(public readonly latestMainnetBundleStartBlockToLoadFromCache: number | undefined) {}
}

export default UBAClientConfig;
